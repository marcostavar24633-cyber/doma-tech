'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');
const { notify } = require('./backup-notifier');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(root, 'backups'));
const logPath = path.join(dataDir, 'backup-operations.jsonl');
const NAME = /^doma-tech-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.sqlite$/;
const TABLES = ['admins', 'products', 'orders', 'sessions'];

function hoursSetting(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0 || value > 24 * 365) {
    throw new Error(`${name} must be a number greater than 0 and no more than 8760`);
  }
  return value;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function verifySqlite(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = db.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`SQLite integrity_check: ${result}`);
    for (const table of TABLES) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        throw new Error(`Missing required table: ${table}`);
      }
    }
  } finally {
    db.close();
  }
}

async function verifyBackup(name) {
  if (!NAME.test(name)) throw new Error('Unexpected backup filename');
  const file = path.join(backupDir, name);
  const manifest = JSON.parse(await fs.readFile(file + '.json', 'utf8'));
  if (manifest.file !== name || manifest.integrity !== 'ok') throw new Error('Manifest does not match backup');
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Manifest createdAt is invalid');
  if (!/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) throw new Error('Manifest SHA-256 is invalid');
  if (await sha256(file) !== manifest.sha256) throw new Error('SHA-256 mismatch');
  verifySqlite(file);
  return manifest;
}

async function readOperations() {
  let content;
  try {
    content = await fs.readFile(logPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], malformed: false };
    throw error;
  }
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  const entries = [];
  let malformed = false;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && typeof entry.status === 'string') entries.push(entry);
      else malformed = true;
    } catch {
      malformed = true;
    }
  }
  return { entries, malformed };
}

async function main() {
  const now = Date.now();
  const localMaxAge = hoursSetting('BACKUP_MAX_AGE_HOURS', 26);
  const offsiteMaxAge = hoursSetting('OFFSITE_MAX_AGE_HOURS', 50);
  const offsiteRequired = process.env.OFFSITE_REQUIRED === 'true';
  const issues = [];
  const warnings = [];
  let backupName = null;
  let backupAgeHours = null;
  let operations = { entries: [], malformed: false };

  try {
    const files = await fs.readdir(backupDir);
    const candidates = files.filter(name => NAME.test(name)).sort().reverse();
    if (!candidates.length) {
      issues.push('Локальные резервные копии не найдены.');
    } else {
      backupName = candidates[0];
      try {
        const manifest = await verifyBackup(backupName);
        backupAgeHours = (now - Date.parse(manifest.createdAt)) / 3600000;
        if (backupAgeHours < -0.1) issues.push('Время создания последней копии находится в будущем.');
        else if (backupAgeHours > localMaxAge) issues.push(`Последняя локальная копия устарела: ${backupAgeHours.toFixed(1)} ч.`);
      } catch (error) {
        issues.push(`Последняя локальная копия не прошла проверку: ${error.message}`);
      }
    }
  } catch (error) {
    issues.push(`Не удалось прочитать каталог резервных копий: ${error.message}`);
  }

  try {
    operations = await readOperations();
    if (operations.malformed) warnings.push('В журнале операций есть повреждённые или некорректные строки.');
    const last = operations.entries.at(-1);
    if (!last) {
      warnings.push('Журнал циклов резервирования отсутствует или пуст.');
    } else if (last.status !== 'success') {
      issues.push('Последний цикл резервирования завершился ошибкой.');
    }
    const latestOffsite = [...operations.entries].reverse().find(entry =>
      entry.status === 'success' && entry.offsite === 'uploaded-and-verified' && Number.isFinite(Date.parse(entry.finishedAt))
    );
    if (offsiteRequired || process.env.OFFSITE_RCLONE_REMOTE) {
      if (!latestOffsite) {
        const message = 'Нет подтверждённой успешной внешней резервной копии в журнале.';
        (offsiteRequired ? issues : warnings).push(message);
      } else {
        const age = (now - Date.parse(latestOffsite.finishedAt)) / 3600000;
        if (age < -0.1 || age > offsiteMaxAge) {
          const message = `Последняя подтверждённая внешняя копия устарела: ${age.toFixed(1)} ч.`;
          (offsiteRequired ? issues : warnings).push(message);
        }
      }
    }
  } catch (error) {
    issues.push(`Не удалось прочитать журнал операций: ${error.message}`);
  }

  const report = {
    status: issues.length ? 'critical' : warnings.length ? 'warning' : 'healthy',
    checkedAt: new Date(now).toISOString(),
    latestBackup: backupName,
    localBackupAgeHours: backupAgeHours === null ? null : Number(backupAgeHours.toFixed(2)),
    operationCount: operations.entries.length,
    issues,
    warnings
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'healthy') {
    await notify(report).catch(error => {
      console.error('Backup notification failed:', error.message);
    });
  }
  if (issues.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'critical', error: error.message }));
  process.exitCode = 1;
});
