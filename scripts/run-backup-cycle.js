'use strict';

require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
const logPath = path.join(dataDir, 'backup-operations.jsonl');

function run(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  return result.stdout.trim();
}

async function writeLog(entry) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

async function main() {
  const startedAt = new Date().toISOString();
  let backupFile = null;
  let offsite = 'skipped';
  try {
    run('backup-db.js');
    const files = await fs.readdir(backupDir);
    const candidates = files
      .filter(name => /^doma-tech-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.sqlite$/.test(name))
      .sort()
      .reverse();

    for (const name of candidates) {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(backupDir, name + '.json'), 'utf8'));
        if (manifest.file === name && manifest.integrity === 'ok' && /^[a-f0-9]{64}$/.test(manifest.sha256 || '')) {
          backupFile = name;
          break;
        }
      } catch {
        // Ignore incomplete or invalid manifests; only select a complete pair.
      }
    }
    if (!backupFile) throw new Error('Backup command completed but no valid backup manifest was found.');

    if (process.env.OFFSITE_RCLONE_REMOTE) {
      run('offsite-backup.js', [backupFile]);
      offsite = 'uploaded-and-verified';
    } else if (process.env.OFFSITE_REQUIRED === 'true') {
      throw new Error('OFFSITE_REQUIRED=true but OFFSITE_RCLONE_REMOTE is not configured.');
    }

    const entry = {
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'success',
      backupFile,
      offsite
    };
    await writeLog(entry);
    console.log(JSON.stringify(entry));
  } catch (error) {
    const entry = {
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 'failed',
      backupFile,
      offsite,
      error: error.message
    };
    await writeLog(entry).catch(logError => {
      console.error('Could not write backup operation log:', logError.message);
    });
    console.error(JSON.stringify(entry));
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('Backup cycle failed:', error.message);
  process.exitCode = 1;
});
