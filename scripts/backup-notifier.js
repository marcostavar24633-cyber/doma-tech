'use strict';

function buildMessage(report) {
  const lines = [
    `DOMA TECH: резервное копирование — ${String(report.status || 'unknown').toUpperCase()}`,
    report.checkedAt ? `Проверено: ${report.checkedAt}` : null,
    report.backupFile || report.latestBackup ? `Копия: ${report.backupFile || report.latestBackup}` : null,
    ...(Array.isArray(report.issues) ? report.issues.map(item => `ОШИБКА: ${item}`) : []),
    ...(Array.isArray(report.warnings) ? report.warnings.map(item => `ПРЕДУПРЕЖДЕНИЕ: ${item}`) : []),
    report.error ? `Ошибка цикла: ${report.error}` : null
  ].filter(Boolean);
  return lines.join('\n').slice(0, 3800);
}

async function postJson(url, body, timeoutMs = 10000) {
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

async function notify(report, env = process.env) {
  const message = buildMessage(report);
  let delivered = 0;
  const errors = [];

  if (env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      errors.push('Telegram notification requires both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
    } else {
      try {
        const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: true }),
            signal: controller.signal
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload.ok !== true) throw new Error(`Telegram API rejected notification (HTTP ${response.status}).`);
          delivered += 1;
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        errors.push(error.name === 'AbortError' ? 'Telegram notification timed out.' : error.message);
      }
    }
  }

  if (env.BACKUP_ALERT_WEBHOOK) {
    try {
      const url = new URL(env.BACKUP_ALERT_WEBHOOK);
      if (url.protocol !== 'https:') throw new Error('BACKUP_ALERT_WEBHOOK must use HTTPS.');
      await postJson(url.toString(), {
        source: 'doma-tech-backup',
        status: report.status || 'unknown',
        message,
        checkedAt: report.checkedAt || new Date().toISOString()
      });
      delivered += 1;
    } catch (error) {
      errors.push(error.name === 'AbortError' ? 'Webhook notification timed out.' : error.message);
    }
  }

  if (errors.length) {
    for (const error of errors) process.stderr.write(`Backup notification: ${error}\n`);
  }
  return { configured: Boolean(env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_CHAT_ID || env.BACKUP_ALERT_WEBHOOK), delivered, errors };
}

module.exports = { buildMessage, notify };
