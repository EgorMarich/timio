import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { clients, messageTemplates, notificationLogs } from "../db/schema.js";
import { scheduleReminder } from "../db/redis.js";
import { DEFAULT_LOCALE, type NotificationChannel } from "../types.js";
import { sendTelegramMessage } from "./telegram/telegram.service.js";

export interface DispatchResult {
  channel: NotificationChannel;
  attempted: NotificationChannel[];
  renderedText: string;
  locale: string;
  status: "sent" | "failed_all_channels";
  // Реальный результат доставки (только для каналов с настоящей интеграцией -
  // сейчас это только Telegram). Для остальных каналов - "simulated": интеграция
  // ещё не подключена, см. комментарий у isChannelAvailable ниже.
  delivery: "delivered" | "failed" | "simulated";
}

type ClientRow = typeof clients.$inferSelect;

// Заглушки "здоровья" канала - в проде реальные health-check'и провайдеров.
function isChannelAvailable(client: ClientRow, channel: NotificationChannel): boolean {
  switch (channel) {
    case "telegram":
      return Boolean(client.telegramChatId);
    case "whatsapp":
    case "viber":
    case "messenger":
    case "sms":
      return Boolean(client.phone);
    case "email":
      return Boolean(client.email);
    default:
      return false;
  }
}

export function resolveChannel(
  client: ClientRow,
  priority: NotificationChannel[]
): { channel: NotificationChannel | null; attempted: NotificationChannel[] } {
  const attempted: NotificationChannel[] = [];
  const order = client.preferredChannel
    ? [client.preferredChannel as NotificationChannel, ...priority.filter((c) => c !== client.preferredChannel)]
    : priority;

  for (const channel of order) {
    attempted.push(channel);
    if (isChannelAvailable(client, channel)) return { channel, attempted };
  }
  return { channel: null, attempted };
}

export function renderTemplate(
  translations: Record<string, string>,
  locale: string,
  vars: Record<string, string>
): { text: string; usedLocale: string } {
  const usedLocale = translations[locale] ? locale : DEFAULT_LOCALE;
  const text = (translations[usedLocale] ?? "").replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
  return { text, usedLocale };
}

/**
 * Резолвит канал + рендерит текст НА ЯЗЫКЕ КЛИЕНТА (client.detectedLocale), логирует
 * попытку в notification_logs и РЕАЛЬНО отправляет сообщение, если для канала
 * подключена настоящая интеграция (сейчас - только Telegram, через собственного
 * бота бизнеса). Остальные каналы (WhatsApp/Viber/Messenger/SMS/Email) пока
 * логируются как "simulated" - интеграции с их платными API - следующий шаг
 * (архитектура уже готова добавить сюда ещё один `if (channel === "whatsapp")`
 * блок ровно по тому же принципу, что и telegram ниже).
 */
export async function dispatchNotification(params: {
  businessId: string;
  clientId: string;
  templateType: string;
  channelPriority: NotificationChannel[];
  telegramBotToken?: string | null;
  vars: Record<string, string>;
}): Promise<DispatchResult | null> {
  const [client] = await db.select().from(clients).where(eq(clients.id, params.clientId));
  const [template] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.businessId, params.businessId), eq(messageTemplates.type, params.templateType)));
  if (!client || !template) return null;

  const { channel, attempted } = resolveChannel(client, params.channelPriority);
  const { text, usedLocale } = renderTemplate(template.translations, client.detectedLocale, params.vars);

  let delivery: DispatchResult["delivery"] = "simulated";

  if (channel === "telegram" && params.telegramBotToken && client.telegramChatId) {
    const sendResult = await sendTelegramMessage(params.telegramBotToken, client.telegramChatId, text);
    delivery = sendResult.ok ? "delivered" : "failed";
  }

  const result: DispatchResult = {
    channel: channel ?? "sms",
    attempted,
    renderedText: text,
    locale: usedLocale,
    status: channel ? "sent" : "failed_all_channels",
    delivery,
  };

  await db.insert(notificationLogs).values({
    clientId: client.id,
    channel: result.channel,
    attemptedChannels: attempted,
    status: result.status,
    renderedText: result.renderedText,
    locale: result.locale,
  });

  return result;
}

/** Ставит в Redis-очередь отложенные напоминания по гибким сценариям (раздел 14 спецификации). */
export async function scheduleAppointmentReminders(appointmentId: string, startAtISO: string) {
  const startAt = new Date(startAtISO).getTime();
  const offsets = [
    { kind: "reminder_24h", ms: 24 * 60 * 60 * 1000 },
    { kind: "reminder_3h", ms: 3 * 60 * 60 * 1000 },
    { kind: "reminder_15m", ms: 15 * 60 * 1000 },
  ];
  for (const offset of offsets) {
    const fireAt = startAt - offset.ms;
    if (fireAt > Date.now()) {
      await scheduleReminder({ appointmentId, fireAt, kind: offset.kind });
    }
  }
}
