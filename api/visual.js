const { getProvider } = require('../lib/providers');
const APPROACH = {
  explain: 'a clear educational illustration explaining the concept',
  sketch: 'a clean, clear educational diagram redrawn from the described sketch',
  compare: 'a before-and-after comparison in two clearly separated panels',
  invisible: 'a visualization that makes an invisible process visible',
  steps: 'a four-panel step-by-step visual guide',
  two: 'two clearly separated panels comparing two scenarios that differ in one variable',
};
const REF = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const provider = getProvider(process.env);
  if (!provider) return res.status(503).json({ error: 'No image provider configured on the server' });
  const { question: q, approach: ap, change, baseScene, reference } = req.body || {};
  if (typeof q !== 'string' || !q.trim() || q.length > 300) return res.status(400).json({ error: 'Question must be 1-300 characters' });
  if (!APPROACH[ap]) return res.status(400).json({ error: 'Unsupported approach' });
  if (reference !== undefined && (typeof reference !== 'string' || reference.length > 3500000 || !REF.test(reference))) return res.status(400).json({ error: 'Reference must be a PNG, JPEG or WebP under about 3 MB' });
  if (ap === 'sketch' && !reference) return res.status(400).json({ error: 'Upload a sketch first' });
  let ch = null;
  if (change !== undefined) {
    const e = change && typeof change === 'object' && !Array.isArray(change) ? Object.entries(change) : null;
    if (!e || !e.length || e.length > 4 || !e.every(([k, v]) => k.length <= 40 && typeof v === 'string' && v.length <= 60)) return res.status(400).json({ error: 'Invalid experiment settings' });
    if (!provider.plan) return res.status(400).json({ error: 'This provider setup cannot run experiments (use IMAGE_PROVIDER=cloudflare)' });
    ch = Object.fromEntries(e);
  }
  const prompt = `${APPROACH[ap]}. Topic: ${q.trim()}.`;
  try {
    let refDesc = null, refNote = null;
    if (reference && !ch) { refNote = provider.describe ? 'failed' : 'unsupported'; if (provider.describe) { refDesc = await provider.describe(reference); if (refDesc) refNote = 'ok'; } }
    let info = provider.plan ? await provider.plan(q.trim(), { change: ch, baseScene: typeof baseScene === 'string' ? baseScene.slice(0, 400) : '', refDesc }) : null;
    if (ch && !info) { // text step failed: still make the picture, and say the outcome text is missing
      info = { scene: `${(typeof baseScene === 'string' && baseScene.slice(0, 300)) || q.trim()}, after changing ${Object.entries(ch).map(([k, v]) => k + ' to ' + v).join(' and ')}`, result: '' };
    }
    const meta = { question: q.trim(), style: APPROACH[ap], scene: info && info.scene, reference: reference && !ch ? reference : undefined };
    const image = await provider.generate(prompt, meta);
    if (provider.locate && info) { const list = info.changes || info.annotations; if (list && list.length) await provider.locate(image, list); }
    res.status(200).json({ image, info, ref: reference && !ch ? { note: refNote, summary: refDesc } : undefined, provider: provider.name, model: meta.usedModel || provider.model });
  } catch (e) { console.error('generate failed:', e.message); res.status(502).json({ error: e.message }); }
};
