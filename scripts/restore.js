"use strict";
// Usage: node scripts/restore.js data/backups/db-XXXX.json   (stop the server first)
const path = require("path");
const { loadEnvFile, getConfig } = require("../src/config");
const { Store } = require("../src/store");
loadEnvFile(path.join(__dirname, "..", ".env"));
(async () => {
  const file = process.argv[2];
  if (!file) { console.error("Give the backup file path."); process.exit(2); }
  const store = new Store(getConfig(), {});
  await store.init();
  const rev = await store.restore(path.resolve(file));
  console.log("Restored. New revision:", rev);
  await store.close(); process.exit(0);
})().catch((e) => { console.error("Restore failed:", e.message); process.exit(1); });
