import { logger } from './log.js';

const API_BASE = 'https://api.telegram.org';

export function createTelegram({ botToken }) {
  if (!botToken) return null;

  async function postJson(path, body) {
    const res = await fetch(`${API_BASE}/bot${botToken}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  async function sendMessage(chatId, text, { parseMode, replyMarkup } = {}) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const body = { chat_id: chatId, text };
        if (parseMode) body.parse_mode = parseMode;
        if (replyMarkup) body.reply_markup = replyMarkup;
        const { res, data } = await postJson('sendMessage', body);
        if (res.ok && data.ok) return { ok: true };
        const permanent =
          res.status === 403 ||
          (res.status === 400 && /chat not found|blocked|kicked|deactivated/i.test(data.description ?? ''));
        if (permanent) {
          logger.error(`Telegram rejected chat ${chatId}: ${data.description ?? `HTTP ${res.status}`}`);
          return { ok: false, permanent: true };
        }
        logger.error(`Telegram API error (attempt ${attempt}/3) chat ${chatId}: HTTP ${res.status} ${data.description ?? ''}`);
      } catch (e) {
        logger.error(`Telegram network error (attempt ${attempt}/3) chat ${chatId}: ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
    return { ok: false, permanent: false };
  }

  async function answerCallbackQuery(callbackQueryId, text) {
    try {
      await postJson('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
    } catch (e) {
      logger.error(`answerCallbackQuery failed: ${e.message}`);
    }
  }

  async function editMessageText(chatId, messageId, text) {
    try {
      const { res, data } = await postJson('editMessageText', { chat_id: chatId, message_id: messageId, text });
      if (!res.ok || !data.ok) {
        logger.error(`editMessageText failed: HTTP ${res.status} ${data.description ?? ''}`);
      }
    } catch (e) {
      logger.error(`editMessageText failed: ${e.message}`);
    }
  }

  async function getUpdates(offset, timeoutSec, signal) {
    const allowed = encodeURIComponent('["message", "callback_query"]');
    const url = `${API_BASE}/bot${botToken}/getUpdates?offset=${offset}&timeout=${timeoutSec}&allowed_updates=${allowed}`;
    const res = await fetch(url, { signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`HTTP ${res.status} ${data.description ?? '(no description)'}`);
    return data.result ?? [];
  }

  return { sendMessage, answerCallbackQuery, editMessageText, getUpdates };
}
