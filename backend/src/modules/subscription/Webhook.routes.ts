// НОВЫЙ ФАЙЛ (модуль подписок)
//
// ЮKassa НЕ подписывает вебхуки криптографически - официальная рекомендация
// (https://yookassa.ru/developers/using-api/webhooks#webhook-authentication):
// не доверять телу запроса напрямую, а повторно запросить платёж по его id
// через API (yooKassa.getPayment) и опираться на этот ответ как на источник
// истины. Именно так и сделано ниже.
//
// Роут публичный (без requireAuth) - монтируется в index.ts отдельно от /me.

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments } from "../../db/schema.js";
import { yooKassa } from "./Yookassa.js";
import { mapYooKassaStatus, attachPaymentMethod, markSubscriptionActive, markSubscriptionExpired } from "./Subscription.service.js";

export const yookassaWebhookRoutes = new Hono();

interface YooKassaWebhookBody {
  event: string;
  object: { id: string };
}

yookassaWebhookRoutes.post("/yookassa", async (c) => {
  const body = await c.req.json<YooKassaWebhookBody>().catch(() => null);
  if (!body?.object?.id) return c.json({ error: "invalid_payload" }, 400);

  // Платёж должен быть уже известен нам (создан через startCardBinding/chargeSubscription) -
  // если его нет в нашей БД, это не наш платёж или подделка запроса, игнорируем.
  const [localPayment] = await db.select().from(payments).where(eq(payments.yookassaPaymentId, body.object.id));
  if (!localPayment) return c.json({ ok: true }); // 200, чтобы ЮKassa не ретраила вечно

  // Источник истины - повторный запрос состояния платежа через API, а не тело вебхука.
  const verifiedPayment = await yooKassa.getPayment(body.object.id);
  const status = mapYooKassaStatus(verifiedPayment.status);

  await db.update(payments).set({ status, rawPayload: verifiedPayment }).where(eq(payments.id, localPayment.id));

  if (status === "succeeded") {
    if (localPayment.purpose === "card_binding") {
      // Карта успешно привязана - сохраняем payment_method_id для будущих
      // автосписаний. Подписка при этом остаётся в статусе "trial" -
      // фактическое списание и переход в "active" произойдёт по cron
      // после окончания 14-дневного периода (см. subscriptionCron.ts).
      const paymentMethodId = verifiedPayment.payment_method?.id;
      if (paymentMethodId) {
        await attachPaymentMethod(localPayment.subscriptionId, paymentMethodId);
      }
    } else if (localPayment.purpose === "recurring") {
      // Обычное/рекуррентное списание прошло успешно - продлеваем подписку.
      await markSubscriptionActive(localPayment.subscriptionId);
    }
  } else if (status === "canceled" || status === "failed") {
    if (localPayment.purpose === "recurring") {
      // Списание не удалось (карта заблокирована, недостаточно средств и т.д.) -
      // подписка переходит в "expired". Пользователь увидит это в дашборде
      // и сможет привязать новую карту / оплатить вручную (следующий шаг развития).
      await markSubscriptionExpired(localPayment.subscriptionId);
    }
    // Провал card_binding-платежа ни на что не влияет - пользователь просто
    // не привязал карту, попробует ещё раз из дашборда.
  }

  return c.json({ ok: true });
});