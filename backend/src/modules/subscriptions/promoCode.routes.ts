// НОВЫЙ ФАЙЛ (модуль подписок)
//
// Создание промокодов - административная операция. В проекте пока нет
// отдельной роли "platform admin" (есть только owner/administrator/manager/
// employee В РАМКАХ бизнеса - см. userRoleEnum в schema.ts), поэтому этот
// роут ТОЛЬКО требует валидный JWT (requireAuth), но НЕ проверяет, что
// пользователь - оператор платформы Timio.
//
// !!! ВАЖНО ДЛЯ ПРОДА: перед реальным запуском сюда нужно добавить проверку
// платформенной админ-роли (например, users.isPlatformAdmin: boolean) -
// иначе любой зарегистрированный владелец бизнеса сможет создавать себе
// промокоды. Это осознанно оставлено как TODO, чтобы не придумывать роль
// "на скорую руку" без согласования с остальной моделью прав доступа.

import { Hono } from "hono";
import { requireAuth } from "../authMiddleware.js";
import { createPromoCode } from "./promoCode.service.js";
import { SubscriptionError } from "./subscription.service.js";

export const promoCodeRoutes = new Hono();
promoCodeRoutes.use("*", requireAuth);

// POST /me/promo-codes { code, discountType, discountValue, maxUses?, expiresAt? }
promoCodeRoutes.post("/promo-codes", async (c) => {
  const body = await c.req.json<{
    code: string;
    discountType: "percent" | "fixed";
    discountValue: number;
    maxUses?: number;
    expiresAt?: string;
  }>();

  if (!body.code || !body.discountType || body.discountValue == null) {
    return c.json({ error: "invalid_input" }, 400);
  }

  try {
    const promo = await createPromoCode({
      code: body.code,
      discountType: body.discountType,
      discountValue: body.discountValue,
      maxUses: body.maxUses,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
    return c.json({ promoCode: promo });
  } catch (err) {
    if (err instanceof SubscriptionError) return c.json({ error: err.code, message: err.message }, 400);
    throw err;
  }
});
