// НОВЫЙ ФАЙЛ (модуль уведомлений)
//
// Реальная интеграция с Telegram Bot API (https://core.telegram.org/bots/api).
// Каждый бизнес подключает СВОЕГО бота (создаётся бесплатно через @BotFather,
// без модерации и верификации - в отличие от WhatsApp Business API/Viber,
// поэтому именно Telegram выбран как первый по-настоящему рабочий канал).
//
// TODO для прода: шифровать telegramBotToken в БД (сейчас хранится открытым
// текстом - см. комментарий у поля в db/schema.ts), добавить ретраи с
// экспоненциальной задержкой при 429 Too Many Requests от Telegram.

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramSendResult {
  ok: boolean;
  description?: string; // текст ошибки от Telegram, если ok: false
}

/** Отправляет текстовое сообщение через sendMessage. */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string
): Promise<TelegramSendResult> {
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  return { ok: Boolean(data.ok), description: data.description };
}

export interface TelegramBotInfo {
  ok: boolean;
  username?: string;
  error?: string;
}

/**
 * Проверяет токен бота через getMe и возвращает его username - используется
 * при сохранении настроек, чтобы сразу показать владельцу рабочую deep-link
 * ссылку вида t.me/<username> и убедиться, что токен реально валиден.
 */
export async function verifyTelegramBotToken(botToken: string): Promise<TelegramBotInfo> {
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getMe`);
    const data = (await res.json()) as { ok: boolean; description?: string; result?: { username?: string } };
    if (!data.ok) return { ok: false, error: data.description ?? "Telegram API вернул ошибку" };
    return { ok: true, username: data.result?.username };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Не удалось связаться с Telegram API" };
  }
}

/** Deep-link для клиента: открывает чат с ботом и сразу шлёт /start с payload = clientId. */
export function buildTelegramConnectLink(botUsername: string, clientId: string): string {
  return `https://t.me/${botUsername}?start=${clientId}`;
}
