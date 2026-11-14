'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

async function main() {
  fs.mkdirSync('artifacts', { recursive: true });
  const server = spawn('python3', ['-m', 'http.server', '4173', '--directory', 'public'], {
    stdio: 'ignore',
    detached: false
  });
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const unexpectedResponses = [];
  const waitForServer = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch('http://127.0.0.1:4173/');
        if (response.ok) return;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Static preview server did not become ready');
  };

  try {
    await waitForServer();
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    desktop.on('pageerror', error => errors.push('desktop pageerror: ' + error.message));
    desktop.on('response', response => {
      const url = new URL(response.url());
      if (url.hostname === '127.0.0.1' && response.status() >= 400 && url.pathname !== '/api/site-config') {
        unexpectedResponses.push('desktop ' + response.status() + ' ' + url.pathname);
      }
    });
    desktop.on('console', message => {
      const source = message.location().url || '';
      if (message.type() === 'error' && source.startsWith('http://127.0.0.1:4173/')) errors.push('desktop console: ' + message.text());
    });
    await desktop.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await desktop.locator('.hero h1').waitFor();
    assert.equal(await desktop.locator('h1').count(), 1, 'The landing page must have one primary H1');
    assert.ok(await desktop.title().then(title => title.includes('DOMA TECH')), 'Page title must identify DOMA TECH');

    const desktopOverflow = await desktop.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(desktopOverflow, false, 'Desktop layout must not overflow horizontally');

    await desktop.locator('#finderForm button[type="submit"]').click();
    await desktop.locator('#finderResult').waitFor({ state: 'visible' });
    assert.match(await desktop.locator('#finderResult').innerText(), /Ваш профиль готов/);
    const downloadPromise = desktop.waitForEvent('download');
    await desktop.locator('#downloadSelection').click();
    const download = await downloadPromise;
    const downloadPath = path.join('artifacts', 'selection-profile.txt');
    await download.saveAs(downloadPath);
    const profile = fs.readFileSync(downloadPath, 'utf8');
    assert.match(profile, /DOMA TECH — мой профиль подбора/);
    assert.match(profile, /Тип установки:/);

    await desktop.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, 0);
    });
    await desktop.waitForFunction(() => window.scrollY === 0);
    await desktop.screenshot({ path: 'artifacts/desktop-1440.png', fullPage: true, animations: 'disabled' });

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true });
    mobile.on('pageerror', error => errors.push('mobile pageerror: ' + error.message));
    mobile.on('response', response => {
      const url = new URL(response.url());
      if (url.hostname === '127.0.0.1' && response.status() >= 400 && url.pathname !== '/api/site-config') {
        unexpectedResponses.push('mobile ' + response.status() + ' ' + url.pathname);
      }
    });
    mobile.on('console', message => {
      const source = message.location().url || '';
      if (message.type() === 'error' && source.startsWith('http://127.0.0.1:4173/')) errors.push('mobile console: ' + message.text());
    });
    await mobile.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(mobileOverflow, false, 'Mobile layout must not overflow horizontally');

    const menuButton = mobile.locator('.menu-toggle');
    await menuButton.click();
    assert.equal(await menuButton.getAttribute('aria-expanded'), 'true', 'Mobile menu button must expose expanded state');
    assert.ok(await mobile.locator('#nav.open').count(), 'Mobile navigation drawer must open');
    await mobile.locator('.nav-group summary').first().click();
    const catalogLink = mobile.locator('.nav-submenu a[href="#catalog"]');
    await catalogLink.waitFor({ state: 'visible' });
    await catalogLink.click();
    assert.equal(await menuButton.getAttribute('aria-expanded'), 'false', 'Selecting a menu item must close the drawer');
    assert.equal(await mobile.locator('body').evaluate(node => node.classList.contains('menu-open')), false, 'Closing the drawer must restore page scrolling');

    await mobile.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, 0);
    });
    await mobile.waitForFunction(() => window.scrollY === 0);
    await mobile.screenshot({ path: 'artifacts/mobile-390.png', fullPage: true, animations: 'disabled' });

    assert.deepEqual(errors, [], 'No uncaught browser JavaScript errors should occur');
    assert.deepEqual(unexpectedResponses, [], 'No unexpected same-origin HTTP errors should occur');
    console.log('Browser viewport metrics:', await mobile.evaluate(() => JSON.stringify({
      innerWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      devicePixelRatio: window.devicePixelRatio
    })));
    console.log('Browser QA passed: desktop layout, mobile layout, menu, local selection, download, screenshots.');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
