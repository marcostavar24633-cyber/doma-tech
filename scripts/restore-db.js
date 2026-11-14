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
const BACKUP_NAME = /^doma-tech-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.sqlite$/;

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
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
    for (const table of ['admins', 'products', 'orders', 'sessions', 'categories', 'site_settings']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new Error(`Database is missing required table: ${table}`);
      }
    }
    const foreignKeyViolations = db.pragma('foreign_key_check');
    if (foreignKeyViolations.length) throw new Error(`SQLite foreign_key_check found ${foreignKeyViolations.length} violation(s)`);
  } finally {
    db.close();
  }
}

async function createSafetyCopy() {
  try {
    await fs.access(livePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const safetyName = `doma-tech-before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`;
  const safetyPath = path.join(backupDir, safetyName);
  const live = new Database(livePath, { readonly: true, fileMustExist: true });
  try {
    await live.backup(safetyPath);
  } finally {
    live.close();
  }
  verifyDatabase(safetyPath);
  return safetyPath;
}

async function main() {
  if (process.env.ALLOW_DB_RESTORE !== 'true') {
    throw new Error('Restore is disabled. Stop the app, then set ALLOW_DB_RESTORE=true to confirm.');
  }

  const filename = process.argv[2];
  if (!filename || path.basename(filename) !== filename || !BACKUP_NAME.test(filename)) {
    throw new Error('Pass an exact verified backup filename from the backups directory, not a path.');
  }

  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });

  const source = path.join(backupDir, filename);
  const manifestPath = `${source}.json`;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.file !== filename || manifest.integrity !== 'ok' || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) {
    throw new Error('Backup manifest is invalid.');
  }
  if (await sha256(source) !== manifest.sha256) throw new Error('Backup SHA-256 does not match its manifest.');
  verifyDatabase(source);

  // On a new server there is no live database to preserve; the verified source
  // becomes the initial database. On an existing server, preserve a safety copy.
  const safetyPath = await createSafetyCopy();
  const staged = path.join(dataDir, `restore-${process.pid}-${crypto.randomBytes(6).toString('hex')}.sqlite`);
  try {
    await fs.copyFile(source, staged, constants.COPYFILE_EXCL);
    verifyDatabase(staged);
    // The app must be stopped so no live SQLite connections or pending WAL writes exist.
    await fs.unlink(`${livePath}-wal`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(`${livePath}-shm`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rename(staged, livePath);
  } catch (error) {
    await fs.unlink(staged).catch(() => {});
    throw error;
  }

  console.log(`Database restored from ${filename}`);
  if (safetyPath) console.log(`Pre-restore safety copy: ${safetyPath}`);
  else console.log('No existing database was present; the verified backup was installed as the initial database.');
  console.log('Start the application in a restricted environment and verify it before accepting traffic.');
}

main().catch(error => {
  console.error('Database restore failed:', error.message);
  process.exitCode = 1;
});
