const { getProvider } = require('../lib/providers');
const APPROACH = {
  explain: 'a clear educational illustration explaining the concept',
  compare: 'a before-and-after comparison in two clearly separated panels',
  invisible: 'a visualization that makes an invisible process visible',
  steps: 'a four-panel step-by-step visual guide',
  two: 'two clearly separated panels comparing two scenarios that differ in one variable',
};
const seedOf = t => { let h = 7; for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 1000003; return h; };
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const provider = getProvider(process.env);
  if (!provider) return res.status(503).json({ error: 'No image provider configured on the server' });
  const { question: q, approach: ap, change } = req.body || {};
  if (typeof q !== 'string' || !q.trim() || q.length > 300) return res.status(400).json({ error: 'Question must be 1-300 characters' });
  if (!APPROACH[ap]) return res.status(400).json({ error: 'Unsupported approach (sketch editing needs an image-edit adapter)' });
  let ch = null;
  if (change !== undefined) {
    const e = change && typeof change === 'object' && !Array.isArray(change) ? Object.entries(change) : null;
    if (!e || !e.length || e.length > 4 || !e.every(([k, v]) => k.length <= 40 && typeof v === 'string' && v.length <= 60)) return res.status(400).json({ error: 'Invalid experiment settings' });
    if (!provider.plan) return res.status(400).json({ error: 'This provider setup cannot run experiments (use IMAGE_PROVIDER=cloudflare)' });
    ch = Object.fromEntries(e);
  }
  const prompt = `${APPROACH[ap]}. Topic: ${q.trim()}. Flat, clean, high-contrast diagram style on a dark navy background.`;
  try {
    const info = provider.plan ? await provider.plan(q.trim(), ch) : null;
    if (ch && (!info || !info.scene)) return res.status(502).json({ error: 'Could not work out the result of that change. Try again.' });
    const image = await provider.generate(prompt, { question: q.trim(), style: APPROACH[ap], scene: info && info.scene, seed: seedOf(q.trim()) });
    if (info) delete info.scene;
    res.status(200).json({ image, info, provider: provider.name, model: provider.model });
  } catch (e) { console.error('generate failed:', e.message); res.status(502).json({ error: e.message }); }
};
