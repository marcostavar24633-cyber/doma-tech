'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'doma-db-maintenance-'));
  const dataDir = path.join(temp, 'data');
  const backupDir = path.join(temp, 'backups');
  await fs.mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'doma-tech.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expires_at INTEGER);
    INSERT INTO products(name) VALUES ('Before backup');
  `);
  db.close();

  const env = { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir };
  try {
    const backupRun = spawnSync(process.execPath, [path.join(__dirname, 'backup-db.js')], { env, encoding: 'utf8' });
    assert.equal(backupRun.status, 0, backupRun.stderr || backupRun.stdout);
    const entries = await fs.readdir(backupDir);
    const filename = entries.find(name => name.endsWith('.sqlite') && name.startsWith('doma-tech-'));
    assert.ok(filename, 'Backup file should be created');

    const live = new Database(dbPath);
    live.prepare('UPDATE products SET name=?').run('After backup');
    live.close();

    const restoreRun = spawnSync(process.execPath, [path.join(__dirname, 'restore-db.js'), filename], {
      env: { ...env, ALLOW_DB_RESTORE: 'true' },
      encoding: 'utf8'
    });
    assert.equal(restoreRun.status, 0, restoreRun.stderr || restoreRun.stdout);

    const restored = new Database(dbPath, { readonly: true });
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(restored.prepare('SELECT name FROM products').get().name, 'Before backup');
    restored.close();

    const denied = spawnSync(process.execPath, [path.join(__dirname, 'restore-db.js'), filename], { env, encoding: 'utf8' });
    assert.notEqual(denied.status, 0, 'Restore must require explicit opt-in');
    console.log('Database maintenance tests passed: backup, SHA-256 manifest, integrity validation, restore, safety copy and opt-in guard.');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
