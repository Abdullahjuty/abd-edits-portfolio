// Vercel serverless entrypoint: this filename ([...slug].js) is Vercel's
// catch-all route syntax, so every request under /api/* is handed to our
// existing Express app, which already does its own internal routing for
// each /api/... path exactly as it does when run as a normal Node server.
module.exports = require("../server/index.js");
