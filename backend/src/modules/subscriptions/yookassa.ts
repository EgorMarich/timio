// НОВЫЙ ФАЙЛ (модуль подписок)
//
// Обёртка над официальным SDK ЮKassa (@a2seven/yoo-checkout - пакет,
// рекомендуемый в документации ЮKassa для Node.js/TypeScript).
// https://yookassa.ru/developers/using-api/interaction-format

import { YooCheckout } from "@a2seven/yoo-checkout";
import { nanoid } from "nanoid";

const shopId = process.env.YOOKASSA_SHOP_ID ?? "";
const secretKey = process.env.YOOKASSA_SECRET_KEY ?? "";

if (!shopId || !secretKey) {
  // Не бросаем исключение при импорте (чтобы остальной API продолжал работать
  // в dev-окружении без настроенной оплаты) - но громко предупреждаем.
  // eslint-disable-next-line no-console
  console.warn(
    "[yookassa] YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не заданы - платежи работать не будут."
  );
}

export const yooKassa = new YooCheckout({ shopId, secretKey });

/** ЮKassa требует Idempotence-Key на каждый POST - генерируем и логируем его сами. */
export function newIdempotenceKey(): string {
  return nanoid(32);
}

export interface CreateCardBindingPaymentParams {
  amountCents: number; // символическая сумма привязки карты (см. subscription.service.ts)
  currency: string;
  description: string;
  returnUrl: string;
  metadata: Record<string, string>;
}

/**
 * Создаёт "привязочный" платёж с save_payment_method: true.
 * Пользователь подтверждает его на странице ЮKassa (3-D Secure и т.д.),
 * после чего вебхук payment.succeeded вернёт payment_method.id, который мы
 * сохраняем как yookassaPaymentMethodId и используем для будущих
 * автоматических списаний БЕЗ участия пользователя.
 */
export async function createCardBindingPayment(params: CreateCardBindingPaymentParams) {
  const idempotenceKey = newIdempotenceKey();
  const payment = await yooKassa.createPayment(
    {
      amount: { value: centsToAmountString(params.amountCents), currency: params.currency },
      capture: true,
      confirmation: { type: "redirect", return_url: params.returnUrl },
      save_payment_method: true,
      description: params.description,
      metadata: params.metadata,
    },
    idempotenceKey
  );
  return { payment, idempotenceKey };
}

export interface ChargeRecurringPaymentParams {
  amountCents: number;
  currency: string;
  description: string;
  paymentMethodId: string; // сохранённый способ оплаты из первого платежа
  metadata: Record<string, string>;
}

/**
 * Рекуррентное списание по уже сохранённому payment_method_id - без
 * confirmation, без участия пользователя. Именно так работает автосписание
 * после окончания пробного периода и ежемесячное продление.
 */
export async function chargeRecurringPayment(params: ChargeRecurringPaymentParams) {
  const idempotenceKey = newIdempotenceKey();
  const payment = await yooKassa.createPayment(
    {
      amount: { value: centsToAmountString(params.amountCents), currency: params.currency },
      capture: true,
      payment_method_id: params.paymentMethodId,
      description: params.description,
      metadata: params.metadata,
    },
    idempotenceKey
  );
  return { payment, idempotenceKey };
}

function centsToAmountString(cents: number): string {
  return (cents / 100).toFixed(2);
}
