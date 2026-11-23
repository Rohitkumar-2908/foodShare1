"use strict";
// Usage: node scripts/backup.js        -> writes data/backups/db-<time>.json
const path = require("path");
const { loadEnvFile, getConfig } = require("../src/config");
const { Store } = require("../src/store");
loadEnvFile(path.join(__dirname, "..", ".env"));
(async () => {
  const store = new Store(getConfig(), {});
  await store.init();
  const f = await store.backup();
  console.log(f ? "Backup written: " + f : "Nothing to back up yet.");
  await store.close(); process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
