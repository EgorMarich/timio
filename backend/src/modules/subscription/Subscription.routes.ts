// НОВЫЙ ФАЙЛ (модуль подписок)
//
// Роуты владельца бизнеса для управления своей подпиской. Смонтированы в
// index.ts как app.route("/me/businesses/:id/subscription", subscriptionRoutes)
// - см. diff в конце файла subscriptionCron.ts / комментарий в index.ts.
//
// Стилистически повторяет me.routes.ts: requireAuth на весь роутер +
// проверка членства в бизнесе перед любым действием.

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { businessMembers, subscriptions } from "../../db/schema.js";
import { requireAuth } from "../authMiddleware.js";
import {
  startTrial,
  startCardBinding,
  cancelSubscription,
  SubscriptionError,
} from "./Subscription.service.js";
import { validatePromoCode } from "./Promocode.service.js";
import { SubscriptionPlan } from "./Pricing.js";

export const subscriptionRoutes = new Hono();
subscriptionRoutes.use("*", requireAuth);

async function assertMember(userId: string, businessId: string) {
  const [membership] = await db
    .select()
    .from(businessMembers)
    .where(and(eq(businessMembers.businessId, businessId), eq(businessMembers.userId, userId)));
  return membership ?? null;
}

function handleSubscriptionError(c: any, err: unknown) {
  if (err instanceof SubscriptionError) {
    const statusByCode: Record<string, number> = {
      not_found: 404,
      already_exists: 409,
      invalid_state: 409,
      no_payment_method: 402,
      inactive: 410,
      expired: 410,
      limit_reached: 410,
      already_used: 409,
      invalid_discount: 400,
    };
    return c.json({ error: err.code, message: err.message }, statusByCode[err.code] ?? 400);
  }
  throw err;
}

// GET /me/businesses/:id/subscription - текущее состояние подписки бизнеса
subscriptionRoutes.get("/businesses/:id/subscription", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.businessId, businessId));
  return c.json({ subscription: subscription ?? null });
});

// POST /me/businesses/:id/subscription/start-trial { plan: "basic" | "business" }
subscriptionRoutes.post("/businesses/:id/subscription/start-trial", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const membership = await assertMember(userId, businessId);
  if (!membership) return c.json({ error: "forbidden" }, 403);
  if (membership.role !== "owner") return c.json({ error: "only_owner_can_manage_billing" }, 403);

  const body = await c.req.json<{ plan: SubscriptionPlan }>();
  if (body.plan !== "basic" && body.plan !== "business") {
    return c.json({ error: "invalid_plan" }, 400);
  }

  try {
    const subscription = await startTrial(businessId, body.plan);
    return c.json({ subscription });
  } catch (err) {
    return handleSubscriptionError(c, err);
  }
});

// POST /me/businesses/:id/subscription/start-card-binding { returnUrl }
// Возвращает confirmationUrl - фронт должен сделать redirect пользователя туда.
subscriptionRoutes.post("/businesses/:id/subscription/start-card-binding", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const membership = await assertMember(userId, businessId);
  if (!membership) return c.json({ error: "forbidden" }, 403);
  if (membership.role !== "owner") return c.json({ error: "only_owner_can_manage_billing" }, 403);

  const body = await c.req.json<{ returnUrl: string }>();
  if (!body.returnUrl) return c.json({ error: "return_url_required" }, 400);

  try {
    const result = await startCardBinding(businessId, body.returnUrl);
    return c.json(result);
  } catch (err) {
    return handleSubscriptionError(c, err);
  }
});

// POST /me/businesses/:id/subscription/cancel
subscriptionRoutes.post("/businesses/:id/subscription/cancel", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const membership = await assertMember(userId, businessId);
  if (!membership) return c.json({ error: "forbidden" }, 403);
  if (membership.role !== "owner") return c.json({ error: "only_owner_can_manage_billing" }, 403);

  try {
    const subscription = await cancelSubscription(businessId);
    return c.json({ subscription });
  } catch (err) {
    return handleSubscriptionError(c, err);
  }
});

// POST /me/businesses/:id/subscription/validate-promo { code }
// Только проверка (без списания/фиксации использования) - для превью скидки в UI
// перед реальной оплатой. Реальное применение - внутри chargeSubscription().
subscriptionRoutes.post("/businesses/:id/subscription/validate-promo", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ code: string }>();
  if (!body.code) return c.json({ error: "code_required" }, 400);

  try {
    const promo = await validatePromoCode(body.code, businessId);
    return c.json({
      valid: true,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
    });
  } catch (err) {
    return handleSubscriptionError(c, err);
  }
});