// НОВЫЙ ФАЙЛ (модуль подписок)
//
// Машина состояний подписки:
//
//   [нет подписки] --startTrial()--> trial --(webhook: карта привязана)--> trial (с картой)
//         trial --(cron: 14 дней истекли + есть карта)--> chargeSubscription() --success--> active
//         trial --(cron: 14 дней истекли, карты нет ИЛИ платёж не прошёл)--> expired
//        active --(cron: конец периода)--> chargeSubscription() --success--> active (период продлён)
//        active --(cron: конец периода, платёж не прошёл)--> expired
//   trial/active --cancelSubscription() (по инициативе пользователя)--> cancelled
//
// cancelled - терминальное состояние по решению пользователя, из него cron
// ничего не списывает и не переводит бизнес обратно в active.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { subscriptions, staff, payments } from '../../db/schema.js';
import {
  calculateMonthlyAmountCents,
  TRIAL_PERIOD_DAYS,
  DEFAULT_CURRENCY,
  type SubscriptionPlan,
} from './Pricing.js';
import { createCardBindingPayment, chargeRecurringPayment } from './Yookassa.js';
import { applyPromoCodeToAmount } from './Promocode.service.js';

// Символическая сумма привязки карты. По требованиям ЮKassa минимальная сумма
// платежа обычно 1.00 в валюте магазина - используем именно эту сумму,
// а не полную стоимость тарифа, т.к. РЕАЛЬНОЕ первое списание должно произойти
// только через 14 дней (после окончания пробного периода), а не сейчас.
const CARD_BINDING_AMOUNT_CENTS = 100; // 1.00 ₽

export class SubscriptionError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

async function getStaffCount(businessId: string): Promise<number> {
  const rows = await db.select().from(staff).where(eq(staff.businessId, businessId));
  return rows.length;
}

/**
 * Запускает пробный период для бизнеса (один раз - повторный вызов для уже
 * существующей подписки запрещён). Подписка создаётся сразу в статусе "trial",
 * привязка карты происходит ОТДЕЛЬНЫМ шагом через startCardBinding(), т.к.
 * требует редиректа пользователя на страницу ЮKassa.
 */
export async function startTrial(businessId: string, plan: SubscriptionPlan) {
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.businessId, businessId));
  if (existing) {
    throw new SubscriptionError('Подписка для этого бизнеса уже существует', 'already_exists');
  }

  const trialEndsAt = new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const [subscription] = await db
    .insert(subscriptions)
    .values({ businessId, plan, status: 'trial', trialEndsAt })
    .returning();

  return subscription;
}

/**
 * Создаёт платёж-привязку карты в ЮKassa и возвращает confirmation_url,
 * на который нужно отправить пользователя. Реальных денег (кроме
 * символической суммы, которая тут же будет списана и может быть возвращена)
 * с пользователя в этот момент не берётся как ПОДПИСКА - см. комментарий
 * к CARD_BINDING_AMOUNT_CENTS выше.
 */
export async function startCardBinding(businessId: string, returnUrl: string) {
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.businessId, businessId));
  if (!subscription) throw new SubscriptionError('Подписка не найдена', 'not_found');
  if (subscription.status !== 'trial') {
    throw new SubscriptionError(
      'Привязка карты доступна только во время пробного периода',
      'invalid_state',
    );
  }

  const { payment, idempotenceKey } = await createCardBindingPayment({
    amountCents: CARD_BINDING_AMOUNT_CENTS,
    currency: DEFAULT_CURRENCY,
    description: `Привязка карты для подписки Timio (бизнес ${businessId})`,
    returnUrl,
    metadata: { businessId, subscriptionId: subscription.id, purpose: 'card_binding' },
  });

  await db.insert(payments).values({
    subscriptionId: subscription.id,
    yookassaPaymentId: payment.id,
    amountCents: CARD_BINDING_AMOUNT_CENTS,
    currency: DEFAULT_CURRENCY,
    status: mapYooKassaStatus(payment.status),
    purpose: 'card_binding',
    idempotenceKey,
    rawPayload: payment,
  });

  return { confirmationUrl: payment.confirmation?.confirmation_url ?? null, paymentId: payment.id };
}

/**
 * Списывает очередной платёж по подписке (первый - после окончания триала,
 * далее - в конце каждого оплаченного периода). Вызывается из cron
 * (subscriptionCron.ts) - см. также webhook-обработчик, который подтверждает
 * успех уже АСИНХРОННО после того, как ЮKassa обработает списание.
 */
export async function chargeSubscription(subscriptionId: string, promoCode?: string) {
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  if (!subscription) throw new SubscriptionError('Подписка не найдена', 'not_found');
  if (!subscription.yookassaPaymentMethodId) {
    // Карта не привязана - списать нечем, переводим в expired (обрабатывается в cron).
    throw new SubscriptionError('К подписке не привязан способ оплаты', 'no_payment_method');
  }

  const staffCount = await getStaffCount(subscription.businessId);
  const baseAmountCents = calculateMonthlyAmountCents(
    subscription.plan as SubscriptionPlan,
    staffCount,
  );

  // Промокод применяется ТОЛЬКО к первому месяцу оплаты (см. ТЗ) - то есть
  // только когда у подписки ещё нет ни одного успешного "recurring"-платежа.
  const previousCharges = await db
    .select()
    .from(payments)
    .where(eq(payments.subscriptionId, subscriptionId));
  const isFirstCharge = !previousCharges.some(
    (p) => p.purpose === 'recurring' && p.status === 'succeeded',
  );

  const amountCents =
    isFirstCharge && promoCode
      ? await applyPromoCodeToAmount(promoCode, subscription.businessId, baseAmountCents)
      : baseAmountCents;

  const { payment, idempotenceKey } = await chargeRecurringPayment({
    amountCents,
    currency: DEFAULT_CURRENCY,
    description: `Подписка Timio (${subscription.plan}), период с ${new Date().toLocaleDateString('ru-RU')}`,
    paymentMethodId: subscription.yookassaPaymentMethodId,
    metadata: {
      businessId: subscription.businessId,
      subscriptionId: subscription.id,
      purpose: 'recurring',
    },
  });

  await db.insert(payments).values({
    subscriptionId: subscription.id,
    yookassaPaymentId: payment.id,
    amountCents,
    currency: DEFAULT_CURRENCY,
    status: mapYooKassaStatus(payment.status),
    purpose: 'recurring',
    idempotenceKey,
    rawPayload: payment,
  });

  return payment;
}

/** Пользователь отменяет подписку - доступ сохраняется до конца оплаченного периода. */
export async function cancelSubscription(businessId: string) {
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.businessId, businessId));
  if (!subscription) throw new SubscriptionError('Подписка не найдена', 'not_found');
  if (subscription.status === 'cancelled') return subscription;

  const [updated] = await db
    .update(subscriptions)
    .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(subscriptions.id, subscription.id))
    .returning();

  return updated;
}

/** Переводит статус подписки в "active" и фиксирует конец оплаченного периода (+30 дней). */
export async function markSubscriptionActive(subscriptionId: string) {
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const [updated] = await db
    .update(subscriptions)
    .set({ status: 'active', currentPeriodEndsAt: periodEnd, updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  return updated;
}

export async function markSubscriptionExpired(subscriptionId: string) {
  const [updated] = await db
    .update(subscriptions)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  return updated;
}

/** Сохраняет payment_method_id после успешной привязки карты (вызывается из вебхука). */
export async function attachPaymentMethod(subscriptionId: string, paymentMethodId: string) {
  const [updated] = await db
    .update(subscriptions)
    .set({ yookassaPaymentMethodId: paymentMethodId, updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  return updated;
}

export function mapYooKassaStatus(status: string): 'pending' | 'succeeded' | 'canceled' | 'failed' {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'canceled') return 'canceled';
  if (status === 'pending' || status === 'waiting_for_capture') return 'pending';
  return 'failed';
}
