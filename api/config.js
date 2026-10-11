const { getProvider } = require('../lib/providers');
module.exports = (req, res) => {
  const p = getProvider(process.env);
  res.status(200).json({ live: !!p, provider: p ? p.name : '', model: p ? p.model : '' });
};
