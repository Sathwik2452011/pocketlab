// Provider adapters. Keys only ever live here, server-side.

const sniff = (b64) => (b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg');

/* ---------------- OpenAI-compatible (POST {base}/images/generations) ---------------- */
async function openaiCompatible(prompt, env) {
  const base = (env.IMAGE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.IMAGE_API_KEY}` },
    body: JSON.stringify({ model: env.IMAGE_MODEL, prompt, n: 1, size: env.IMAGE_SIZE || '1024x1024' }),
    signal: AbortSignal.timeout(50000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `Provider returned HTTP ${res.status}`);
  const d = j.data && j.data[0];
  if (d && d.b64_json) return 'data:image/png;base64,' + d.b64_json;
  if (d && d.url) return d.url;
  throw new Error('Provider response contained no image');
}

/* ---------------- Gemini ---------------- */
async function gemini(prompt, env) {
  const model = env.IMAGE_MODEL || 'gemini-2.5-flash-image';
  const base = (env.IMAGE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const res = await fetch(`${base}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.IMAGE_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    signal: AbortSignal.timeout(50000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `Gemini returned HTTP ${res.status}`);
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const img = parts.find(p => p.inlineData && p.inlineData.data);
  if (!img) throw new Error('Gemini returned no image');
  return `data:${img.inlineData.mimeType || 'image/png'};base64,${img.inlineData.data}`;
}

/* ---------------- Cloudflare Workers AI ---------------- */
function cfRun(env, model, body, ms = 30000) {
  const base = (env.IMAGE_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
  return fetch(`${base}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.IMAGE_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
}
const str = (x, n) => (typeof x === 'string' ? x.trim().slice(0, n) : '');
function parseLoose(t) {
  const m = typeof t === 'string' && t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const s = m[0].replace(/[\r\n\t]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch { return null; }
}
async function llmJson(env, system, user, max) {
  const model = env.PROMPT_MODEL || '@cf/meta/llama-3.1-8b-instruct';
  for (let i = 0; i < 2; i++) { // one retry: small models sometimes return broken JSON
    try {
      const r = await cfRun(env, model, { max_tokens: max, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, 25000);
      const j = await r.json();
      const t = j && j.result && j.result.response;
      const o = t && typeof t === 'object' ? t : parseLoose(t);
      if (o) return o;
    } catch (e) { console.error('llm call failed:', e.message); }
  }
  return null;
}

// Vision: describe the student's uploaded image so it can steer the new picture.
async function describe(dataUrl, env) {
  const model = env.VISION_MODEL || '@cf/meta/llama-3.2-11b-vision-instruct';
  const ask = () => cfRun(env, model, { messages: [{ role: 'user', content: 'Describe this image for a science tutor in under 110 words: what it shows, the main objects, any readable labels, arrows and relationships. If it is not educational content, say what it is.' }], image: dataUrl, max_tokens: 300 }, 25000);
  try {
    let r = await ask(), j = await r.json().catch(() => ({}));
    if (!(r.ok && j.result && j.result.response) && /agree|licen/i.test(JSON.stringify(j.errors || ''))) {
      await cfRun(env, model, { prompt: 'agree' }, 15000); // one-time acceptance of Meta's licence for this model
      r = await ask(); j = await r.json().catch(() => ({}));
    }
    const t = j.result && j.result.response;
    if (!(typeof t === 'string' && t.trim())) console.error('vision failed:', JSON.stringify(j.errors || j).slice(0, 300));
    return typeof t === 'string' && t.trim() ? t.trim().slice(0, 700) : null;
  } catch (e) { console.error('vision error:', e.message); return null; }
}

const SCENE_RULES = 'max 60 words; one scientifically faithful scene showing the real mechanism or arrangement, with concrete shapes, materials, colours, arrows, camera angle and lighting; state roughly where each key object sits in the frame (left, centre, right, top, bottom); no quotes, titles, labels, numbers or equations';
const clamp = (n) => Math.max(5, Math.min(95, Math.round(n)));
const cleanNotes = (arr, max) => (Array.isArray(arr) ? arr : [])
  .filter(a => a && str(a.label, 30) && str(a.text, 160) && Number.isFinite(+a.x) && Number.isFinite(+a.y))
  .slice(0, max).map(a => ({ label: str(a.label, 30), text: str(a.text, 160), x: clamp(+a.x), y: clamp(+a.y) }));
const NOTE_SPEC = '"label" (max 3 words naming one object in the scene), "text" (max 18 words saying what it is and why it matters), "x" and "y" (numbers 5-95: that object\'s centre as a percent from the left and from the top of the picture, matching the layout you described in "scene")';
async function plan(question, env, opt = {}) {
  const { change, baseScene, refDesc } = opt;
  if (change) {
    const o = await llmJson(env,
      `You are a careful science tutor. A student changed variables in an experiment about their question. Reply with ONLY a JSON object with keys: "scene" (${SCENE_RULES}; show the situation AFTER the change, keeping the same composition as the original scene), "headline" (max 14 words: what changed), "changes" (array of 2 to 4 objects pointing at the objects that are different now, each with ${NOTE_SPEC}; "text" must say what is different compared with the original and why), "result" (max 50 words; if the change makes no real difference say so; invent no numbers).`,
      `Question: ${question}\nOriginal scene: ${baseScene || 'n/a'}\nChanges: ${Object.entries(change).map(([k, v]) => k + ' = ' + v).join('; ')}`, 800);
    if (!o || !str(o.scene, 400)) return null;
    return { scene: str(o.scene, 400).replace(/"+/g, ' '), headline: str(o.headline, 120), changes: cleanNotes(o.changes, 4), result: str(o.result, 400) };
  }
  const o = await llmJson(env,
    `You are a careful science tutor. Reply with ONLY a JSON object, no markdown, with keys: "scene" (${SCENE_RULES}), "headline" (max 14 words: the key idea that answers the question; do not invent facts), "annotations" (array of 3 to 5 objects, each with ${NOTE_SPEC}), "quiz" (object with "q", "options" array of exactly 3 strings, "answer" the index 0-2 of the correct option, "why" one sentence), "variables" (array of 2 or 3 objects, each with "name" of at most 3 words for something the student could change that genuinely affects the outcome, and "options" an array of exactly 3 short strings of at most 4 words).`,
    question + (refDesc ? `\n\nThe student also uploaded an image. An AI vision model described it as: ${refDesc}\nBase the scene on what the image shows, keeping its intended concept.` : ''), 1200);
  if (!o) return null;
  const q = o.quiz, okQ = q && str(q.q, 200) && Array.isArray(q.options) && q.options.length === 3 && q.options.every(x => typeof x === 'string') && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 3;
  const vars = (Array.isArray(o.variables) ? o.variables : []).filter(v => v && str(v.name, 40) && Array.isArray(v.options) && v.options.length === 3 && v.options.every(x => typeof x === 'string' && x.trim())).slice(0, 3).map(v => ({ name: str(v.name, 40), options: v.options.map(x => x.trim().slice(0, 40)) }));
  return {
    scene: str(o.scene, 400).replace(/"+/g, ' '),
    headline: str(o.headline, 120),
    annotations: cleanNotes(o.annotations, 5),
    quiz: okQ ? { q: str(q.q, 200), options: q.options.map(x => x.slice(0, 120)), answer: q.answer, why: str(q.why, 250) } : null,
    variables: vars,
  };
}

const STYLE = 'Cinematic, immersive wide-angle composition, dramatic volumetric lighting, glowing violet and cyan accents against a deep navy background, rich depth and atmosphere, ultra detailed, sharp focus, purely visual with no writing or lettering.';
async function runImage(model, prompt, env) {
  const hq = /lucid|phoenix/.test(model);
  const body = hq ? { prompt, width: +env.IMAGE_WIDTH || 1280, height: +env.IMAGE_HEIGHT || 720, steps: +env.IMAGE_STEPS || 25, guidance: 5.5 } : { prompt, steps: +env.FLUX_STEPS || 6 };
  const res = await cfRun(env, model, body, 40000);
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('image/')) return `data:${type};base64,` + Buffer.from(await res.arrayBuffer()).toString('base64');
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare returned HTTP ${res.status}`);
  const b64 = (j.result && j.result.image) || j.image;
  if (!b64) throw new Error('Cloudflare response contained no image');
  return `data:${sniff(b64)};base64,${b64}`;
}
async function cloudflare(prompt, env, meta) {
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set');
  const models = env.IMAGE_MODEL ? [env.IMAGE_MODEL] : ['@cf/leonardo/lucid-origin', '@cf/black-forest-labs/flux-1-schnell'];
  const p = meta && meta.scene ? `${meta.scene}. ${STYLE} Layout: ${meta.style}.` : `${meta ? meta.style + ' about ' + meta.question : prompt}. ${STYLE}`;
  let last;
  for (const m of models) {
    try { const img = await runImage(m, p, env); if (meta) meta.usedModel = m; return img; }
    catch (e) { last = e; console.error(`image model ${m} failed:`, e.message); }
  }
  throw last;
}

async function custom() { // INTEGRATION POINT for any other API: return a data: URL or https image URL.
  throw new Error('IMAGE_PROVIDER=custom is selected but custom() in lib/providers.js is not implemented yet');
}

const PROVIDERS = { cloudflare, gemini, 'openai-compatible': openaiCompatible, custom };
function getProvider(env) {
  const name = env.IMAGE_PROVIDER;
  if (!name || !env.IMAGE_API_KEY || !PROVIDERS[name]) return null;
  const cf = name === 'cloudflare';
  return {
    name,
    model: env.IMAGE_MODEL || (name === 'gemini' ? 'gemini-2.5-flash-image' : cf ? '@cf/leonardo/lucid-origin' : ''),
    generate: (p, meta) => PROVIDERS[name](p, env, meta),
    plan: cf ? (q, opt) => plan(q, env, opt) : null,
    describe: cf ? (img) => describe(img, env) : null,
  };
}
module.exports = { getProvider };
