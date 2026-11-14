'use strict';

const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildMessage, notify } = require('./backup-notifier');

async function main() {
  const alertText = buildMessage({ status: 'critical', error: 'simulated failure', issues: ['Backup missing'] });
  assert.match(alertText, /DOMA TECH/);
  assert.match(alertText, /simulated failure/);
  assert.match(alertText, /Backup missing/);
  const noNotification = await notify({ status: 'critical' }, {});
  assert.equal(noNotification.configured, false);
  assert.equal(noNotification.delivered, 0);

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
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO products(name) VALUES ('Before backup');
  `);
  db.close();

  const env = { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir, BACKUP_RETENTION_COUNT: '2' };
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

    // A tampered backup must be rejected before touching the live database or creating a safety copy.
    const tamperedName = filename.replace(/([a-f0-9]{8})\.sqlite$/, 'deadbeef.sqlite');
    const tamperedManifest = { ...JSON.parse(await fs.readFile(path.join(backupDir, filename + '.json'), 'utf8')), file: tamperedName };
    await fs.copyFile(path.join(backupDir, filename), path.join(backupDir, tamperedName));
    await fs.appendFile(path.join(backupDir, tamperedName), Buffer.from('tampered'));
    await fs.writeFile(path.join(backupDir, tamperedName + '.json'), JSON.stringify(tamperedManifest));
    const safetyBeforeTamper = (await fs.readdir(backupDir)).filter(name => name.startsWith('doma-tech-before-restore-')).length;
    const tamperedRestore = spawnSync(process.execPath, [path.join(__dirname, 'restore-db.js'), tamperedName], {
      env: { ...env, ALLOW_DB_RESTORE: 'true' },
      encoding: 'utf8'
    });
    assert.notEqual(tamperedRestore.status, 0, 'Restore must reject a backup whose contents do not match its SHA-256 manifest');
    const afterRejectedRestore = new Database(dbPath, { readonly: true });
    assert.equal(afterRejectedRestore.prepare('SELECT name FROM products').get().name, 'Before backup',
      'Rejected restore must leave the live database unchanged');
    afterRejectedRestore.close();
    const safetyAfterTamper = (await fs.readdir(backupDir)).filter(name => name.startsWith('doma-tech-before-restore-')).length;
    assert.equal(safetyAfterTamper, safetyBeforeTamper, 'Rejected backup must be rejected before creating a safety copy');
    await fs.unlink(path.join(backupDir, tamperedName));
    await fs.unlink(path.join(backupDir, tamperedName + '.json'));

    for (let index = 0; index < 4; index += 1) {
      const rotated = spawnSync(process.execPath, [path.join(__dirname, 'backup-db.js')], { env, encoding: 'utf8' });
      assert.equal(rotated.status, 0, rotated.stderr || rotated.stdout);
    }
    const rotatedEntries = await fs.readdir(backupDir);
    const validBackups = rotatedEntries.filter(name => /^doma-tech-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.sqlite$/.test(name));
    assert.equal(validBackups.length, 2, 'Rotation must retain exactly the configured number of verified backups');
    for (const backupName of validBackups) {
      const manifest = JSON.parse(await fs.readFile(path.join(backupDir, backupName + '.json'), 'utf8'));
      assert.equal(manifest.file, backupName);
      assert.equal(manifest.integrity, 'ok');
      assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
    }

    const mockRclone = path.join(temp, 'mock-rclone.js');
    const rcloneLog = path.join(temp, 'rclone-args.jsonl');
    await fs.writeFile(mockRclone, [
      '#!/usr/bin/env node',
      'require("node:fs").appendFileSync(process.env.RCLONE_TEST_LOG, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));'
    ].join(String.fromCharCode(10)) + String.fromCharCode(10));
    await fs.chmod(mockRclone, 0o755);
    const offsiteRun = spawnSync(process.execPath, [path.join(__dirname, 'offsite-backup.js'), validBackups[0]], {
      env: { ...env, OFFSITE_RCLONE_REMOTE: 'encrypted-test:doma-tech', RCLONE_BIN: mockRclone, RCLONE_TEST_LOG: rcloneLog },
      encoding: 'utf8'
    });
    assert.equal(offsiteRun.status, 0, offsiteRun.stderr || offsiteRun.stdout);
    const rcloneCalls = (await fs.readFile(rcloneLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rcloneCalls.length, 4, 'Offsite flow must upload and read-back verify the database and manifest');
    assert.deepEqual(rcloneCalls.map(args => args[0]), ['copyto', 'check', 'copyto', 'check']);
    assert.ok(rcloneCalls.every(args => args.includes('--download') || args[0] === 'copyto'));

    const remoteDir = path.join(temp, 'remote');
    const restoredBackupDir = path.join(temp, 'downloaded-backups');
    await fs.mkdir(remoteDir, { recursive: true });
    await fs.mkdir(restoredBackupDir, { recursive: true });
    await fs.copyFile(path.join(backupDir, validBackups[0]), path.join(remoteDir, validBackups[0]));
    await fs.copyFile(path.join(backupDir, validBackups[0] + '.json'), path.join(remoteDir, validBackups[0] + '.json'));
    const downloadMock = path.join(temp, 'mock-rclone-download.js');
    await fs.writeFile(downloadMock, [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const [command, source, target] = process.argv.slice(2);',
      'if (command !== "copyto") process.exit(2);',
      'const from = source.includes(":") ? path.join(process.env.RCLONE_TEST_REMOTE_DIR, path.basename(source)) : source;',
      'const to = target.includes(":") ? path.join(process.env.RCLONE_TEST_REMOTE_DIR, path.basename(target)) : target;',
      'fs.copyFileSync(from, to);'
    ].join('\n') + '\n');
    await fs.chmod(downloadMock, 0o755);
    const downloadRun = spawnSync(process.execPath, [path.join(__dirname, 'offsite-restore-download.js'), validBackups[0]], {
      env: { ...env, BACKUP_DIR: restoredBackupDir, OFFSITE_RCLONE_REMOTE: 'encrypted-test:doma-tech', RCLONE_BIN: downloadMock, RCLONE_TEST_REMOTE_DIR: remoteDir },
      encoding: 'utf8'
    });
    assert.equal(downloadRun.status, 0, downloadRun.stderr || downloadRun.stdout);
    const downloaded = path.join(restoredBackupDir, validBackups[0]);
    assert.equal(await fs.readFile(downloaded).then(data => data.length), await fs.readFile(path.join(remoteDir, validBackups[0])).then(data => data.length));
    assert.equal(JSON.parse(await fs.readFile(downloaded + '.json', 'utf8')).file, validBackups[0]);

    // Disaster-recovery drill: restore the downloaded offsite copy into an isolated,
    // deliberately divergent database and verify application data after restoration.
    const disasterDataDir = path.join(temp, 'disaster-recovery-data');
    await fs.mkdir(disasterDataDir, { recursive: true });
    const disasterDbPath = path.join(disasterDataDir, 'doma-tech.sqlite');
    const disasterDb = new Database(disasterDbPath);
    disasterDb.exec(`
      CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
      CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expires_at INTEGER);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO products(name) VALUES ('Divergent disaster state');
    `);
    disasterDb.close();

    const disasterRestore = spawnSync(process.execPath, [path.join(__dirname, 'restore-db.js'), validBackups[0]], {
      env: { ...env, DATA_DIR: disasterDataDir, BACKUP_DIR: restoredBackupDir, ALLOW_DB_RESTORE: 'true' },
      encoding: 'utf8'
    });
    assert.equal(disasterRestore.status, 0, disasterRestore.stderr || disasterRestore.stdout);
    const disasterRestoredDb = new Database(disasterDbPath, { readonly: true });
    assert.equal(disasterRestoredDb.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(disasterRestoredDb.prepare('SELECT name FROM products').get().name, 'Before backup');
    disasterRestoredDb.close();
    const disasterFiles = await fs.readdir(restoredBackupDir);
    assert.ok(disasterFiles.some(name => name.startsWith('doma-tech-before-restore-') && name.endsWith('.sqlite')),
      'Disaster recovery must preserve a pre-restore safety copy');


    // Clean-server recovery: install a verified backup when no live SQLite file exists.
    const cleanDataDir = path.join(temp, 'clean-server-data');
    const cleanBackupDir = path.join(temp, 'clean-server-backups');
    await fs.mkdir(cleanDataDir, { recursive: true });
    await fs.mkdir(cleanBackupDir, { recursive: true });
    await fs.copyFile(downloaded, path.join(cleanBackupDir, validBackups[0]));
    await fs.copyFile(downloaded + '.json', path.join(cleanBackupDir, validBackups[0] + '.json'));
    const cleanRestore = spawnSync(process.execPath, [path.join(__dirname, 'restore-db.js'), validBackups[0]], {
      env: { ...env, DATA_DIR: cleanDataDir, BACKUP_DIR: cleanBackupDir, ALLOW_DB_RESTORE: 'true' },
      encoding: 'utf8'
    });
    assert.equal(cleanRestore.status, 0, cleanRestore.stderr || cleanRestore.stdout);
    const cleanDbPath = path.join(cleanDataDir, 'doma-tech.sqlite');
    const cleanRestoredDb = new Database(cleanDbPath, { readonly: true });
    assert.equal(cleanRestoredDb.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(cleanRestoredDb.prepare('SELECT name FROM products').get().name, 'Before backup');
    cleanRestoredDb.close();
    assert.ok(cleanRestore.stdout.includes('No existing database was present'));

    const cycleDataDir = path.join(temp, 'cycle-data');
    const cycleBackupDir = path.join(temp, 'cycle-backups');
    await fs.mkdir(cycleDataDir, { recursive: true });
    const cycleDbPath = path.join(cycleDataDir, 'doma-tech.sqlite');
    const cycleDb = new Database(cycleDbPath);
    cycleDb.exec(`
      CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
      CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE sessions (sid TEXT PRIMARY KEY, sess TEXT, expires_at INTEGER);
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT);
    `);
    cycleDb.close();
    const cycleRun = spawnSync(process.execPath, [path.join(__dirname, 'run-backup-cycle.js')], {
      env: { ...process.env, DATA_DIR: cycleDataDir, BACKUP_DIR: cycleBackupDir, BACKUP_RETENTION_COUNT: '2', OFFSITE_RCLONE_REMOTE: '' },
      encoding: 'utf8'
    });
    assert.equal(cycleRun.status, 0, cycleRun.stderr || cycleRun.stdout);
    const cycleLog = (await fs.readFile(path.join(cycleDataDir, 'backup-operations.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(cycleLog.length, 1);
    assert.equal(cycleLog[0].status, 'success');
    assert.equal(cycleLog[0].offsite, 'skipped');

    assert.ok(cycleLog[0].backupFile);

    const healthRun = spawnSync(process.execPath, [path.join(__dirname, 'check-backup-health.js')], {
      env: { ...process.env, DATA_DIR: cycleDataDir, BACKUP_DIR: cycleBackupDir, BACKUP_MAX_AGE_HOURS: '26' },
      encoding: 'utf8'
    });
    assert.equal(healthRun.status, 0, healthRun.stderr || healthRun.stdout);
    assert.equal(JSON.parse(healthRun.stdout).status, 'healthy');

    const staleHealthRun = spawnSync(process.execPath, [path.join(__dirname, 'check-backup-health.js')], {
      env: { ...process.env, DATA_DIR: cycleDataDir, BACKUP_DIR: cycleBackupDir, BACKUP_MAX_AGE_HOURS: '0.000001' },
      encoding: 'utf8'
    });
    assert.notEqual(staleHealthRun.status, 0, 'Health check must fail for a stale local backup');
    assert.equal(JSON.parse(staleHealthRun.stdout).status, 'critical');


    console.log('Database maintenance tests passed: backup, SHA-256 manifest, integrity validation, restore, safety copy, opt-in guard, retention rotation, offsite upload verification, offsite download, isolated disaster-recovery restore and clean-server initial restore validation, scheduled backup cycle and notification formatting/no-config behavior.');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
