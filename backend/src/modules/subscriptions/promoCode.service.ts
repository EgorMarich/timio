// НОВЫЙ ФАЙЛ (модуль подписок)
//
// Промокоды применяются ТОЛЬКО к первому оплаченному месяцу подписки
// (проверка "первый ли это платёж" - в subscription.service.ts:chargeSubscription).

import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { promoCodes, promoCodeRedemptions } from "../../db/schema.js";
import { SubscriptionError } from "./subscription.service.js";

export interface CreatePromoCodeInput {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number; // percent: 0-100; fixed: сумма скидки в копейках
  maxUses?: number;
  expiresAt?: Date;
}

export async function createPromoCode(input: CreatePromoCodeInput) {
  if (input.discountType === "percent" && (input.discountValue <= 0 || input.discountValue > 100)) {
    throw new SubscriptionError("Процентная скидка должна быть в диапазоне 1-100", "invalid_discount");
  }
  if (input.discountType === "fixed" && input.discountValue <= 0) {
    throw new SubscriptionError("Фиксированная скидка должна быть положительной", "invalid_discount");
  }

  const [promo] = await db
    .insert(promoCodes)
    .values({
      code: input.code.trim().toUpperCase(),
      discountType: input.discountType,
      discountValue: input.discountValue,
      maxUses: input.maxUses ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();

  return promo;
}

/**
 * Проверяет промокод (существование, активность, срок действия, лимит
 * использований, повторное использование ЭТИМ бизнесом) БЕЗ побочных
 * эффектов - удобно для превью скидки в UI до реальной оплаты.
 */
export async function validatePromoCode(code: string, businessId: string) {
  const [promo] = await db.select().from(promoCodes).where(eq(promoCodes.code, code.trim().toUpperCase()));

  if (!promo) throw new SubscriptionError("Промокод не найден", "not_found");
  if (!promo.isActive) throw new SubscriptionError("Промокод больше не активен", "inactive");
  if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) {
    throw new SubscriptionError("Срок действия промокода истёк", "expired");
  }
  if (promo.maxUses != null && promo.usedCount >= promo.maxUses) {
    throw new SubscriptionError("Промокод исчерпал лимит использований", "limit_reached");
  }

  const [alreadyUsed] = await db
    .select()
    .from(promoCodeRedemptions)
    .where(and(eq(promoCodeRedemptions.promoCodeId, promo.id), eq(promoCodeRedemptions.businessId, businessId)));
  if (alreadyUsed) {
    throw new SubscriptionError("Этот промокод уже был использован для данного бизнеса", "already_used");
  }

  return promo;
}

/** Считает сумму со скидкой (в копейках), не применяя промокод (без записи использования). */
export function calculateDiscountedAmount(
  amountCents: number,
  discountType: "percent" | "fixed",
  discountValue: number
): number {
  const discounted =
    discountType === "percent" ? amountCents - Math.round((amountCents * discountValue) / 100) : amountCents - discountValue;
  return Math.max(0, discounted);
}

/**
 * Валидирует промокод и АТОМАРНО фиксирует его использование (инкремент
 * usedCount + запись в promo_code_redemptions), возвращая итоговую сумму
 * к списанию. Вызывается из chargeSubscription() непосредственно перед
 * реальным платежом.
 */
export async function applyPromoCodeToAmount(code: string, businessId: string, amountCents: number): Promise<number> {
  const promo = await validatePromoCode(code, businessId);

  await db.insert(promoCodeRedemptions).values({ promoCodeId: promo.id, businessId });
  await db
    .update(promoCodes)
    .set({ usedCount: promo.usedCount + 1 })
    .where(eq(promoCodes.id, promo.id));

  return calculateDiscountedAmount(amountCents, promo.discountType, promo.discountValue);
}
