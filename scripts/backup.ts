// Online backup of the SQLite database (safe while the app is running).
//   npm run backup                  → $DATA_DIR/backups/raft-review-<timestamp>.sqlite
//   npm run backup -- /path/out.sqlite
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const source = path.join(dataDir, "raft-review.sqlite");
if (!fs.existsSync(source)) {
  console.error(`no database at ${source} (set DATA_DIR)`);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.resolve(process.argv[2] ?? path.join(dataDir, "backups", `raft-review-${stamp}.sqlite`));
fs.mkdirSync(path.dirname(dest), { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
const pages = await backup(db, dest);
db.close();
console.log(JSON.stringify({ ok: true, dest, pages }));
