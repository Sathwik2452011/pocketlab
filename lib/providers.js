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

async function cloudflare(prompt, env) {
  // Cloudflare Workers AI REST: POST /accounts/{id}/ai/run/{model}, Bearer API token, JSON body with prompt.
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set');
  const model = env.IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
  const base = (env.IMAGE_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
  const res = await fetch(`${base}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.IMAGE_API_KEY}` },
    body: JSON.stringify({ prompt, steps: 4 }),
    signal: AbortSignal.timeout(90000),
  });
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
  return { name, model: env.IMAGE_MODEL || (name === 'gemini' ? 'gemini-2.5-flash-image' : name === 'cloudflare' ? '@cf/black-forest-labs/flux-1-schnell' : ''), generate: (p) => PROVIDERS[name](p, env) };
}
module.exports = { getProvider };
