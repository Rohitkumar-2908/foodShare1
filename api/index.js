"use strict";
// Vercel entry point. Every dynamic URL (/api/*, /healthz, /readyz, /metrics) is rewritten here by vercel.json.
// The app is created once per warm instance; the database connection is reused between requests.
const { createApp } = require("../server");

let app;
module.exports = function handler(req, res) {
  if (!app) app = createApp({ serverless: true });
  return app.handler(req, res);
};
