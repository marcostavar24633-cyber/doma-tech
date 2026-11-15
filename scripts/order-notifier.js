'use strict';

function buildOrderMessage(order) {
  const id = Number(order && order.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('A valid order id is required');
  const createdAt = typeof order.createdAt === 'string' && order.createdAt
    ? order.createdAt
    : 'время не указано';
  return ['DOMA TECH: новая заявка', `Номер: #${id}`, `Создана: ${createdAt}`].join('\\n');
}

async function requestJson(url, body, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Notification endpoint returned HTTP ${response.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function notifyOrder(order, env = process.env) {
  const configured = Boolean(
    env.ORDER_TELEGRAM_BOT_TOKEN || env.ORDER_TELEGRAM_CHAT_ID || env.ORDER_ALERT_WEBHOOK
  );
  if (!configured) return { configured: false, delivered: 0, errors: [] };

  let delivered = 0;
  const errors = [];
  let message;
  try {
    message = buildOrderMessage(order);
  } catch (error) {
    return { configured, delivered, errors: [error.message] };
  }

  if (env.ORDER_TELEGRAM_BOT_TOKEN || env.ORDER_TELEGRAM_CHAT_ID) {
    if (!env.ORDER_TELEGRAM_BOT_TOKEN || !env.ORDER_TELEGRAM_CHAT_ID) {
      errors.push('Order Telegram notification requires both ORDER_TELEGRAM_BOT_TOKEN and ORDER_TELEGRAM_CHAT_ID.');
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${env.ORDER_TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: env.ORDER_TELEGRAM_CHAT_ID,
              text: message,
              disable_web_page_preview: true
            }),
            signal: controller.signal
          }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok !== true) {
          throw new Error(`Telegram API rejected notification (HTTP ${response.status}).`);
        }
        delivered += 1;
      } catch (error) {
        errors.push(error.name === 'AbortError' ? 'Order Telegram notification timed out.' : error.message);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  if (env.ORDER_ALERT_WEBHOOK) {
    try {
      const url = new URL(env.ORDER_ALERT_WEBHOOK);
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('ORDER_ALERT_WEBHOOK must be an HTTPS URL without embedded credentials.');
      }
      await requestJson(url.toString(), {
        source: 'doma-tech-order',
        orderId: Number(order.id),
        createdAt: typeof order.createdAt === 'string' ? order.createdAt : null
      });
      delivered += 1;
    } catch (error) {
      errors.push(error.name === 'AbortError' ? 'Order webhook notification timed out.' : error.message);
    }
  }

  return { configured, delivered, errors };
}

module.exports = { buildOrderMessage, notifyOrder };
