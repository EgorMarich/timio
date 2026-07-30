// НОВЫЙ ФАЙЛ (модуль подписок)
//
// В проекте пока нет воркера очередей (BullMQ подключен в package.json как
// зависимость для будущих напоминаний, но ни один воркер его ещё не читает -
// см. db/redis.ts: scheduleReminder/popDueReminders). Чтобы не вносить новую
// инфраструктуру ради одной задачи, используем тот же лёгкий подход - простой
// периодический поллер на setInterval, вызываемый из index.ts при старте сервера.
//
// В проде это естественно заменяется на настоящую cron-задачу (например,
// BullMQ repeatable job или системный cron, вызывающий отдельный скрипт) -
// логика самой проверки (runSubscriptionCronTick) от способа запуска не зависит.

import { and, eq, lte } from "drizzle-orm";
import { db } from "../../db/client.js";
import { subscriptions } from "../../db/schema.js";
import { chargeSubscription, markSubscriptionExpired, SubscriptionError } from "./Subscription.service.js";

const CRON_INTERVAL_MS = Number(process.env.SUBSCRIPTION_CRON_INTERVAL_MS ?? 60 * 60 * 1000); // раз в час по умолчанию

/**
 * Один "тик" проверки подписок:
 *  1. Триалы, у которых истёк 14-дневный срок - пытаемся списать первый платёж
 *     (если карта привязана) или сразу переводим в expired (если не привязана).
 *  2. Активные подписки, у которых закончился оплаченный период - пытаемся
 *     списать следующий платёж (продление).
 *
 * Фактический переход в "active"/"expired" по результату списания происходит
 * АСИНХРОННО через webhook.routes.ts (payment.succeeded/payment.canceled),
 * т.к. ЮKassa обрабатывает платёж не мгновенно.
 */
export async function runSubscriptionCronTick() {
  const now = new Date();

  const expiredTrials = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.status, "trial"), lte(subscriptions.trialEndsAt, now)));

  for (const sub of expiredTrials) {
    if (!sub.yookassaPaymentMethodId) {
      // Карта так и не была привязана за 14 дней - подписка не активируется.
      await markSubscriptionExpired(sub.id);
      continue;
    }
    await tryCharge(sub.id);
  }

  const dueRenewals = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.status, "active"), lte(subscriptions.currentPeriodEndsAt, now)));

  for (const sub of dueRenewals) {
    await tryCharge(sub.id);
  }

  return { checkedTrials: expiredTrials.length, checkedRenewals: dueRenewals.length };
}

async function tryCharge(subscriptionId: string) {
  try {
    await chargeSubscription(subscriptionId);
  } catch (err) {
    // Ошибка на этапе СОЗДАНИЯ платежа (например, ЮKassa API недоступен) -
    // не трогаем статус подписки, попробуем на следующем тике cron.
    // Ошибки уже СОЗДАННОГО, но неуспешного платежа обрабатываются в вебхуке.
    // eslint-disable-next-line no-console
    console.error(
      `[subscription-cron] Не удалось создать платёж для подписки ${subscriptionId}:`,
      err instanceof SubscriptionError ? err.message : err
    );
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Запускает периодическую проверку. Вызывается один раз при старте сервера (см. index.ts). */
export function startSubscriptionCron() {
  if (intervalHandle) return; // защита от повторного запуска
  // eslint-disable-next-line no-console
  console.log(`[subscription-cron] started, interval ${CRON_INTERVAL_MS}ms`);
  intervalHandle = setInterval(() => {
    runSubscriptionCronTick().catch((err) => console.error("[subscription-cron] tick failed:", err));
  }, CRON_INTERVAL_MS);
}

export function stopSubscriptionCron() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}