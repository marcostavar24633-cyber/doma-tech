'use strict';

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
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
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('SQLite integrity check failed.');
    }
    for (const table of ['admins', 'products', 'orders', 'sessions']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new Error(`Backup is missing required table: ${table}`);
      }
    }
  } finally {
    db.close();
  }
}

async function main() {
  const remoteBase = process.env.OFFSITE_RCLONE_REMOTE;
  if (!remoteBase || !/^[A-Za-z0-9_-]+:[^\r\n]*$/.test(remoteBase)) {
    throw new Error('Set OFFSITE_RCLONE_REMOTE to a configured rclone destination, e.g. secure-backups:doma-tech.');
  }
  const filename = process.argv[2];
  if (!filename || path.basename(filename) !== filename || !BACKUP_NAME.test(filename)) {
    throw new Error('Pass the exact backup filename created by db:backup.');
  }

  const backupPath = path.join(backupDir, filename);
  const manifestPath = `${backupPath}.json`;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.file !== filename || manifest.integrity !== 'ok') {
    throw new Error('Backup manifest is invalid.');
  }
  if (await sha256(backupPath) !== manifest.sha256) {
    throw new Error('Backup SHA-256 does not match its manifest.');
  }
  verifyDatabase(backupPath);

  const destination = `${remoteBase.replace(/\/$/, '')}/${filename}`;
  const manifestDestination = `${destination}.json`;
  for (const [source, target] of [[backupPath, destination], [manifestPath, manifestDestination]]) {
    const result = spawnSync(process.env.RCLONE_BIN || 'rclone', ['copyto', source, target], {
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`rclone copyto failed for ${path.basename(source)}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
    }
  }

  console.log(`Offsite copy uploaded: ${destination}`);
  console.log('Both SQLite backup and SHA-256 manifest were transferred. Remote files were not deleted or pruned.');
}

main().catch(error => {
  console.error('Offsite backup failed:', error.message);
  process.exitCode = 1;
});
