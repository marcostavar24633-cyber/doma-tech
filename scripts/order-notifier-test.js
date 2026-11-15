'use strict';

const assert = require('node:assert/strict');
const { buildOrderMessage, notifyOrder } = require('./order-notifier');

async function main() {
  const originalFetch = global.fetch;
  let calls = [];
  try {
    global.fetch = async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      if (String(url).includes('api.telegram.org')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 204 };
    };

    assert.equal(buildOrderMessage({ id: 17, createdAt: '2026-11-15 12:00:00' }),
      'DOMA TECH: новая заявка\\nНомер: #17\\nСоздана: 2026-11-15 12:00:00');
    assert.throws(() => buildOrderMessage({ id: 'bad' }), /valid order id/i);

    const noChannels = await notifyOrder({ id: 1 }, {});
    assert.deepEqual(noChannels, { configured: false, delivered: 0, errors: [] });
    assert.equal(calls.length, 0);

    const telegram = await notifyOrder(
      { id: 17, createdAt: '2026-11-15 12:00:00', name: 'Private Name', contact: '+70000000000' },
      { ORDER_TELEGRAM_BOT_TOKEN: 'test-token', ORDER_TELEGRAM_CHAT_ID: '12345' }
    );
    assert.equal(telegram.delivered, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\\.telegram\\.org/);
    assert.match(calls[0].body.text, /#17/);
    assert.doesNotMatch(calls[0].body.text, /Private Name|70000000000/);

    calls = [];
    const webhook = await notifyOrder(
      { id: 18, createdAt: '2026-11-15 12:01:00', contact: 'private@example.invalid' },
      { ORDER_ALERT_WEBHOOK: 'https://hooks.example.test/orders' }
    );
    assert.equal(webhook.delivered, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.orderId, 18);
    assert.equal(calls[0].body.source, 'doma-tech-order');
    assert.equal(JSON.stringify(calls[0].body).includes('private@example.invalid'), false);

    calls = [];
    const invalidWebhook = await notifyOrder(
      { id: 19 },
      { ORDER_ALERT_WEBHOOK: 'http://hooks.example.test/orders' }
    );
    assert.equal(invalidWebhook.delivered, 0);
    assert.match(invalidWebhook.errors[0], /HTTPS/);
    assert.equal(calls.length, 0);

    const incompleteTelegram = await notifyOrder(
      { id: 20 },
      { ORDER_TELEGRAM_BOT_TOKEN: 'token-only' }
    );
    assert.equal(incompleteTelegram.delivered, 0);
    assert.match(incompleteTelegram.errors[0], /requires both/);

    process.stdout.write('Order notification tests passed\\n');
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\\n`);
  process.exitCode = 1;
});
