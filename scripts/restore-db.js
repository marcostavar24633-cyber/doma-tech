'use strict';

require('dotenv').config();

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
const livePath = path.join(dataDir, 'doma-tech.sqlite');

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

async function verifyDatabase(filePath) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
    for (const table of ['admins', 'products', 'orders', 'sessions']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new Error(`Database is missing required table: ${table}`);
      }
    }
  } finally {
    db.close();
  }
}

async function main() {
  if (process.env.ALLOW_DB_RESTORE !== 'true') {
    throw new Error('Restore is disabled. Stop the app, then set ALLOW_DB_RESTORE=true to confirm.');
  }
  const filename = process.argv[2];
  if (!filename || path.basename(filename) !== filename || !/^doma-tech-[\w.-]+\.sqlite$/.test(filename)) {
    throw new Error('Pass a backup filename from the backups directory, not a path.');
  }

  const source = path.join(backupDir, filename);
  const manifestPath = `${source}.json`;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.file !== filename || manifest.integrity !== 'ok') throw new Error('Backup manifest is invalid.');
  const actualHash = await sha256(source);
  if (actualHash !== manifest.sha256) throw new Error('Backup SHA-256 does not match its manifest.');
  await verifyDatabase(source);

  await fs.mkdir(dataDir, { recursive: true });
  await fs.access(livePath);
  const safetyName = `doma-tech-before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
  const safetyPath = path.join(backupDir, safetyName);
  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  try {
    await live.backup(safetyPath);
  } finally {
    live.close();
  }
  await verifyDatabase(safetyPath);

  const staged = path.join(dataDir, `restore-${process.pid}.sqlite`);
  try {
    await fs.copyFile(source, staged, constants.COPYFILE_EXCL);
    await verifyDatabase(staged);
    // The app must be stopped so no live SQLite connections or pending WAL writes exist.
    await fs.unlink(`${livePath}-wal`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(`${livePath}-shm`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rename(staged, livePath);
  } catch (error) {
    await fs.unlink(staged).catch(() => {});
    throw error;
  }

  console.log(`Database restored from ${filename}`);
  console.log(`Pre-restore safety copy: ${safetyPath}`);
  console.log('Restart the application before accepting traffic.');
}

main().catch(error => {
  console.error('Database restore failed:', error.message);
  process.exitCode = 1;
});
