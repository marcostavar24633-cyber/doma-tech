'use strict';

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
const sourcePath = path.join(dataDir, 'doma-tech.sqlite');

async function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function main() {
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.access(sourcePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `doma-tech-${stamp}.sqlite`;
  const destination = path.join(backupDir, filename);
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }

  const check = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = check.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Backup integrity check failed: ${integrity}`);
    for (const table of ['admins', 'products', 'orders', 'sessions']) {
      const found = check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!found) throw new Error(`Backup is missing required table: ${table}`);
    }
  } finally {
    check.close();
  }

  const manifest = {
    file: filename,
    createdAt: new Date().toISOString(),
    sha256: await sha256(destination),
    integrity: 'ok'
  };
  await fs.writeFile(`${destination}.json`, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`Backup created and verified: ${destination}`);
  console.log(`SHA-256: ${manifest.sha256}`);
}

main().catch(error => {
  console.error('Database backup failed:', error.message);
  process.exitCode = 1;
});
