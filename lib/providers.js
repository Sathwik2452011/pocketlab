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

async function custom(prompt, env) {
  // INTEGRATION POINT for a sponsor API. Read their docs, then:
  //  1. call their endpoint with env.IMAGE_API_KEY (never send the key to the browser)
  //  2. return a data: URL (base64) or an https image URL
  throw new Error('IMAGE_PROVIDER=custom is selected but providers.js custom() is not implemented yet');
}

const PROVIDERS = { 'openai-compatible': openaiCompatible, custom };

function getProvider(env) {
  const name = env.IMAGE_PROVIDER;
  if (!name || !env.IMAGE_API_KEY || !PROVIDERS[name]) return null;
  return { name, model: env.IMAGE_MODEL || '', generate: (p) => PROVIDERS[name](p, env) };
}
module.exports = { getProvider };
