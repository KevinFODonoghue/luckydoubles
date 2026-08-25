// Local / long-running entry point. On Vercel the app is served from
// api/index.js instead — this file never runs there.

const app = require('./src/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🎳 Lucky Doubles running at http://localhost:${PORT}`);
});
