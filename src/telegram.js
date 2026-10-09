import { logger } from './log.js';

const API_BASE = 'https://api.telegram.org';

export function createTelegram({ botToken, chatId }) {
  if (!botToken || !chatId) return null;

  async function sendMessage(text) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) return true;
        logger.error(`Telegram API error (attempt ${attempt}/3): HTTP ${res.status} ${data.description ?? '(no description)'}`);
      } catch (e) {
        logger.error(`Telegram network error (attempt ${attempt}/3): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
    return false;
  }

  return { sendMessage };
}

export async function showChatIds(botToken) {
  if (!botToken) {
    logger.error('telegram.botToken is missing in config.json — create a bot with @BotFather first.');
    process.exit(1);
  }
  try {
    const res = await fetch(`${API_BASE}/bot${botToken}/getUpdates`);
    const data = await res.json();
    if (!data.ok) {
      logger.error(`Telegram getUpdates failed: ${data.description ?? `HTTP ${res.status}`}`);
      process.exit(1);
    }
    const chats = new Map();
    for (const u of data.result ?? []) {
      const msg = u.message ?? u.edited_message ?? u.channel_post;
      if (msg?.chat) chats.set(String(msg.chat.id), msg.chat);
    }
    if (chats.size === 0) {
      console.log('No chats found yet. Send any message to your bot (or add it to a group and post there), then run this again.');
      return;
    }
    console.log('Chats seen by your bot:');
    for (const [id, chat] of chats) {
      const name = chat.title ?? chat.first_name ?? chat.username ?? '';
      console.log(`  chat_id: ${id}  (${chat.type}${name ? `, ${name}` : ''})`);
    }
    console.log('\nCopy the chat_id into telegram.chatId in config.json.');
  } catch (e) {
    logger.error(`Could not reach Telegram: ${e.message}`);
    process.exit(1);
  }
}
