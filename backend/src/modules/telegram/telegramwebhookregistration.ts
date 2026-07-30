// НОВЫЙ ФАЙЛ (модуль уведомлений)
//
// Telegram шлёт апдейты (входящие сообщения) на webhook-URL, который бот
// регистрирует через setWebhook. У каждого бизнеса свой бот -> свой webhook-путь
// /webhooks/telegram/:businessId, чтобы по URL сразу понимать, какому бизнесу
// принадлежит апдейт (без необходимости искать бизнес по токену на каждый запрос).

const TELEGRAM_API_BASE = "https://api.telegram.org";

export async function registerTelegramWebhook(botToken: string, businessId: string): Promise<{ ok: boolean; error?: string }> {
  const publicBase = process.env.PUBLIC_API_BASE_URL;
  if (!publicBase) {
    // В локальной разработке (localhost) Telegram физически не может достучаться
    // до нас - регистрацию пропускаем, но это не ошибка конфигурации бота.
    return { ok: false, error: "PUBLIC_API_BASE_URL не задан - webhook не зарегистрирован (нормально для локальной разработки)" };
  }

  const webhookUrl = `${publicBase.replace(/\/$/, "")}/webhooks/telegram/${businessId}`;
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  return data.ok ? { ok: true } : { ok: false, error: data.description };
}

export async function unregisterTelegramWebhook(botToken: string): Promise<void> {
  await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/deleteWebhook`, { method: "POST" }).catch(() => {
    // Отвязка бота не должна падать из-за недоступности Telegram - токен всё равно чистим в БД.
  });
}
