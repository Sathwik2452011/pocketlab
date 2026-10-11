const { getProvider } = require('../lib/providers');
const APPROACH = {
  explain: 'a clear educational illustration explaining the concept',
  compare: 'a before-and-after comparison in two clearly separated panels',
  invisible: 'a visualization that makes an invisible process visible',
  steps: 'a four-panel step-by-step visual guide',
  two: 'two clearly separated panels comparing two scenarios that differ in one variable',
};
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const provider = getProvider(process.env);
  if (!provider) return res.status(503).json({ error: 'No image provider configured on the server' });
  const { question: q, approach: ap } = req.body || {};
  if (typeof q !== 'string' || !q.trim() || q.length > 300) return res.status(400).json({ error: 'Question must be 1-300 characters' });
  if (!APPROACH[ap]) return res.status(400).json({ error: 'Unsupported approach (sketch editing needs an image-edit adapter)' });
  const prompt = `${APPROACH[ap]}. Topic: ${q.trim()}. Flat, clean, high-contrast diagram style on a dark navy background. Do not include any text, letters, numbers or labels anywhere in the image.`;
  try {
    const image = await provider.generate(prompt);
    res.status(200).json({ image, provider: provider.name, model: provider.model });
  } catch (e) { console.error('generate failed:', e.message); res.status(502).json({ error: e.message }); }
};
