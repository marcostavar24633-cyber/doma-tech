'use strict';

require('dotenv').config();

const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
const BACKUP_NAME = /^doma-tech-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.sqlite$/;

function runRclone(args) {
  const result = spawnSync(process.env.RCLONE_BIN || 'rclone', args, {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`rclone ${args[0]} failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
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
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('SQLite integrity check failed.');
    }
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

async function main() {
  const remoteBase = process.env.OFFSITE_RCLONE_REMOTE;
  if (!remoteBase || !/^[A-Za-z0-9_-]+:[^\r\n]*$/.test(remoteBase)) {
    throw new Error('Set OFFSITE_RCLONE_REMOTE to a configured rclone destination.');
  }
  const filename = process.argv[2];
  if (!filename || path.basename(filename) !== filename || !BACKUP_NAME.test(filename)) {
    throw new Error('Pass the exact backup filename stored in the offsite destination.');
  }

  const remoteFile = `${remoteBase.replace(/\/$/, '')}/${filename}`;
  const remoteManifest = `${remoteFile}.json`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doma-tech-offsite-'));
  const tempFile = path.join(tempDir, filename);
  const tempManifest = `${tempFile}.json`;
  let installedFile = false;
  let installedManifest = false;

  try {
    runRclone(['copyto', remoteManifest, tempManifest]);
    runRclone(['copyto', remoteFile, tempFile]);

    const manifest = JSON.parse(await fs.readFile(tempManifest, 'utf8'));
    if (manifest.file !== filename || manifest.integrity !== 'ok' || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) {
      throw new Error('Downloaded backup manifest is invalid.');
    }
    if (await sha256(tempFile) !== manifest.sha256) {
      throw new Error('Downloaded backup SHA-256 does not match its manifest.');
    }
    verifyDatabase(tempFile);

    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    const localFile = path.join(backupDir, filename);
    const localManifest = `${localFile}.json`;
    await fs.copyFile(tempFile, localFile, constants.COPYFILE_EXCL);
    installedFile = true;
    await fs.copyFile(tempManifest, localManifest, constants.COPYFILE_EXCL);
    installedManifest = true;

    console.log(`Offsite backup downloaded and verified: ${localFile}`);
    console.log('No database was restored or overwritten. Use the normal guarded restore command after stopping the app.');
  } catch (error) {
    if (installedManifest) await fs.unlink(path.join(backupDir, `${filename}.json`)).catch(() => {});
    if (installedFile) await fs.unlink(path.join(backupDir, filename)).catch(() => {});
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('Offsite restore download failed:', error.message);
  process.exitCode = 1;
});
