// Vercel serverless entry point. Every route is rewritten here (see
// vercel.json); the Express app handles the original request path.

module.exports = require('../src/app');
