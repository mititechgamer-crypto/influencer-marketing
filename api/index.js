// Vercel serverless entrypoint. Wraps the Express app; reuses a single
// initialized instance across cold/warm invocations.
const { app, ensureInitialized } = require('../server');

module.exports = async (req, res) => {
  await ensureInitialized();
  return app(req, res);
};
