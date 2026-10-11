// Provider adapters. Each takes (prompt, env) and returns an image as a data: URL or https URL.
// Add a new provider by writing one function and registering it in PROVIDERS below.

async function openaiCompatible(prompt, env) {
  // Matches the widely used "POST {base}/images/generations" shape.
  // VERIFY against your provider's docs: model names, size values and response fields differ.
  const base = (env.IMAGE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.IMAGE_API_KEY}` },
    body: JSON.stringify({ model: env.IMAGE_MODEL, prompt, n: 1, size: env.IMAGE_SIZE || '1024x1024' }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Provider returned HTTP ${res.status}`);
  const d = j.data && j.data[0];
  if (d && d.b64_json) return 'data:image/png;base64,' + d.b64_json;
  if (d && d.url) return d.url; // some providers return short-lived URLs
  throw new Error('Provider response contained no image');
}

async function gemini(prompt, env) {
  // Gemini API (Google AI Studio key). Image output uses generateContent with IMAGE in responseModalities.
  const model = env.IMAGE_MODEL || 'gemini-2.5-flash-image';
  const base = (env.IMAGE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const res = await fetch(`${base}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.IMAGE_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `Gemini returned HTTP ${res.status}`);
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const img = parts.find(p => p.inlineData && p.inlineData.data);
  if (!img) throw new Error('Gemini returned no image (it may have refused the prompt or the model does not support image output)');
  return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
}

async function cfRun(env, model, body) {
  const base = (env.IMAGE_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
  return fetch(`${base}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.IMAGE_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
}

// Text-model calls via Workers AI. Base call: scene + explanation + steps + quiz + variables.
// Change call: scene + predicted result after the student changes variables.
const str = (x, n) => (typeof x === 'string' ? x.trim().slice(0, n) : '');
async function llmJson(env, system, user, max) {
  const model = env.PROMPT_MODEL || '@cf/meta/llama-3.1-8b-instruct';
  const r = await cfRun(env, model, { max_tokens: max, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  const j = await r.json();
  let t = j && j.result && j.result.response;
  if (t && typeof t === 'object') return t;
  const m = typeof t === 'string' && t.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}
const NOWORDS = 'no quotes, titles, labels, numbers or equations in it';
async function plan(question, env, change) {
  try {
    if (change) {
      const o = await llmJson(env,
        `You are a careful science tutor. A student changed variables in a thought experiment about their question. Reply with ONLY a JSON object with keys: "scene" (max 45 words: one clear visual scene showing the situation AFTER the change, same layout as the original; ${NOWORDS}) and "result" (max 70 words: what happens now compared with the default, and why; if the change makes no real difference say so; invent no numbers).`,
        `Question: ${question}\nChanges: ${Object.entries(change).map(([k, v]) => k + ' = ' + v).join('; ')}`, 500);
      if (!o) return null;
      return { scene: str(o.scene, 400).replace(/["\n]+/g, ' '), result: str(o.result, 600) };
    }
    const o = await llmJson(env,
      `You are a careful science tutor. Reply with ONLY a JSON object, no markdown, with keys: "scene" (max 45 words describing one clear visual scene with shapes, objects, colours and arrows; ${NOWORDS}), "explanation" (max 90 words, plain language for a student; if the question rests on a false assumption say so; do not invent facts), "steps" (array of 3-4 short strings), "quiz" (object with "q", "options" array of exactly 3 strings, "answer" the index 0-2 of the correct option, "why" one sentence), "variables" (array of 2 or 3 objects, each with "name" of at most 3 words for something the student could change that genuinely affects the outcome, and "options" an array of exactly 3 short strings of at most 4 words).`,
      question, 900);
    if (!o) return null;
    const q = o.quiz, okQ = q && str(q.q, 200) && Array.isArray(q.options) && q.options.length === 3 && q.options.every(x => typeof x === 'string') && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 3;
    const vars = (Array.isArray(o.variables) ? o.variables : []).filter(v => v && str(v.name, 40) && Array.isArray(v.options) && v.options.length === 3 && v.options.every(x => typeof x === 'string' && x.trim())).slice(0, 3).map(v => ({ name: str(v.name, 40), options: v.options.map(x => x.trim().slice(0, 40)) }));
    return {
      scene: str(o.scene, 400).replace(/["\n]+/g, ' '),
      explanation: str(o.explanation, 800),
      steps: Array.isArray(o.steps) ? o.steps.filter(x => typeof x === 'string').slice(0, 5).map(x => x.slice(0, 200)) : [],
      quiz: okQ ? { q: str(q.q, 200), options: q.options.map(x => x.slice(0, 120)), answer: q.answer, why: str(q.why, 250) } : null,
      variables: vars,
    };
  } catch { return null; }
}

async function cloudflare(prompt, env, meta) {
  // Cloudflare Workers AI REST: POST /accounts/{id}/ai/run/{model}, Bearer API token, JSON body with prompt.
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set');
  const model = env.IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  let p = prompt;
  if (meta && meta.question) {
    const scene = meta.scene || null;
    p = scene ? `${scene}. ${meta.style}, clean flat vector illustration, dark navy background, simple shapes, purely visual with no writing.`
              : `${meta.style} about ${meta.question}. Clean flat vector illustration, dark navy background, purely visual.`;
  }
  const res = await cfRun(env, model, { prompt: p, steps: +env.FLUX_STEPS || 6 });
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('image/')) return `data:${type};base64,` + Buffer.from(await res.arrayBuffer()).toString('base64');
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare returned HTTP ${res.status}`);
  const b64 = (j.result && j.result.image) || j.image;
  if (!b64) throw new Error('Cloudflare response contained no image (check IMAGE_MODEL supports text-to-image)');
  return 'data:image/jpeg;base64,' + b64;
}

async function custom(prompt, env) {
  // INTEGRATION POINT for a sponsor API. Read their docs, then:
  //  1. call their endpoint with env.IMAGE_API_KEY (never send the key to the browser)
  //  2. return a data: URL (base64) or an https image URL
  throw new Error('IMAGE_PROVIDER=custom is selected but providers.js custom() is not implemented yet');
}

const PROVIDERS = { cloudflare, gemini, 'openai-compatible': openaiCompatible, custom };

function getProvider(env) {
  const name = env.IMAGE_PROVIDER;
  if (!name || !env.IMAGE_API_KEY || !PROVIDERS[name]) return null;
  return { name, model: env.IMAGE_MODEL || (name === 'gemini' ? 'gemini-2.5-flash-image' : name === 'cloudflare' ? '@cf/black-forest-labs/flux-1-schnell' : ''), generate: (p, meta) => PROVIDERS[name](p, env, meta),
    plan: name === 'cloudflare' ? (q, ch) => plan(q, env, ch) : null };
}
module.exports = { getProvider };
