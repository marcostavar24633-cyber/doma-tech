'use strict';

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
const sourcePath = path.join(dataDir, 'doma-tech.sqlite');
const BACKUP_NAME = /^doma-tech-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.sqlite$/;
const REQUIRED_TABLES = ['admins', 'products', 'orders', 'sessions'];

function retentionCount() {
  const value = process.env.BACKUP_RETENTION_COUNT === undefined ? 7 : Number(process.env.BACKUP_RETENTION_COUNT);
  if (!Number.isSafeInteger(value) || value < 2 || value > 365) {
    throw new Error('BACKUP_RETENTION_COUNT must be an integer from 2 to 365');
  }
  return value;
}

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

function verifyDatabase(filePath) {
  const check = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = check.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
    for (const table of REQUIRED_TABLES) {
      const found = check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!found) throw new Error(`Backup is missing required table: ${table}`);
    }
  } finally {
    check.close();
  }
}

async function isVerifiedBackup(filename) {
  if (!BACKUP_NAME.test(filename)) return false;
  const filePath = path.join(backupDir, filename);
  try {
    const manifest = JSON.parse(await fs.readFile(`${filePath}.json`, 'utf8'));
    if (manifest.file !== filename || manifest.integrity !== 'ok') return false;
    if (await sha256(filePath) !== manifest.sha256) return false;
    verifyDatabase(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pruneOldBackups(currentFilename, keepCount) {
  const entries = await fs.readdir(backupDir);
  const candidates = entries.filter(name => BACKUP_NAME.test(name)).sort().reverse();
  const verified = [];
  for (const filename of candidates) {
    if (await isVerifiedBackup(filename)) verified.push(filename);
  }

  // Never prune until the new backup and its manifest have both passed verification.
  const retained = new Set(verified.slice(0, keepCount));
  retained.add(currentFilename);
  const removed = [];
  for (const filename of verified) {
    if (retained.has(filename)) continue;
    await fs.unlink(path.join(backupDir, filename));
    await fs.unlink(`${path.join(backupDir, filename)}.json`).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    removed.push(filename);
  }
  return { retained: Math.min(verified.length, keepCount), removed };
}

async function main() {
  const keepCount = retentionCount();
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
  await fs.access(sourcePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `doma-tech-${stamp}-${crypto.randomBytes(4).toString('hex')}.sqlite`;
  const destination = path.join(backupDir, filename);
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }

  verifyDatabase(destination);
  const manifest = {
    file: filename,
    createdAt: new Date().toISOString(),
    sha256: await sha256(destination),
    integrity: 'ok'
  };
  await fs.writeFile(`${destination}.json`, JSON.stringify(manifest, null, 2) + '\\n', { mode: 0o600, flag: 'wx' });

  // Re-read the just-written manifest and verify the backup before any cleanup.
  if (!(await isVerifiedBackup(filename))) throw new Error('New backup failed final verification; old backups were left untouched.');
  const rotation = await pruneOldBackups(filename, keepCount);

  console.log(`Backup created and verified: ${destination}`);
  console.log(`SHA-256: ${manifest.sha256}`);
  console.log(`Retention: keep ${keepCount}; removed ${rotation.removed.length} verified old backup(s).`);
}

main().catch(error => {
  console.error('Database backup failed:', error.message);
  process.exitCode = 1;
});
