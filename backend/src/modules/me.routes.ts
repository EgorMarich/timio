import { Hono } from "hono";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { businesses, businessMembers, services, staff, appointments, clients, messageTemplates, users, subscriptions, campaigns, waitlistEntries } from "../db/schema.js";
import { requireAuth } from "./authMiddleware.js";
import { generateUniqueSlug } from "./slug.js";
import { defaultTemplates } from "./defaultTemplates.js";
import { redis, invalidateAllAvailability } from "../db/redis.js";
import { sendTelegramMessage } from "../modules/telegram/telegram.service.js";
import { handleSlotFreed } from './waitlist/waitlist.service.js';
import { joinWaitlist } from './waitlist/waitlist.service.js';

export const meRoutes = new Hono();
meRoutes.use("*", requireAuth);

// Проверяет, что текущий пользователь имеет доступ к бизнесу, и возвращает его роль.
async function assertMember(userId: string, businessId: string) {
  const [membership] = await db
    .select()
    .from(businessMembers)
    .where(and(eq(businessMembers.businessId, businessId), eq(businessMembers.userId, userId)));
  return membership ?? null;
}

// GET /me/businesses - все компании, к которым у пользователя есть доступ
meRoutes.get("/businesses", async (c) => {
  const userId = c.get("userId") as string;
  const memberships = await db.select().from(businessMembers).where(eq(businessMembers.userId, userId));
  const businessIds = memberships.map((m) => m.businessId);
  if (businessIds.length === 0) return c.json({ businesses: [] });

  const rows = await Promise.all(
    businessIds.map(async (id) => {
      const [b] = await db.select().from(businesses).where(eq(businesses.id, id));
      const membership = memberships.find((m) => m.businessId === id);
      return { ...b, myRole: membership?.role };
    })
  );
  return c.json({ businesses: rows });
});

// ---------- Управление статусом записи ----------
//
// Владелец/менеджер может вручную перевести запись в любой допустимый статус:
// подтвердить (confirmed), отметить выполненной (completed), отменить (cancelled),
// зафиксировать неявку (no_show). Переход booked → confirmed делается автоматически
// при оплате (если подключён эквайринг), но здесь - ручное управление из дашборда.
//
// После перевода в completed обновляем CRM-счётчики клиента (visits, totalSpentCents,
// lastVisitAt) - чтобы карточка клиента всегда отражала реальную историю.
meRoutes.patch("/businesses/:id/appointments/:apptId", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const apptId = c.req.param("apptId");

  if (!(await assertMember(userId, businessId)))
    return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ status: string }>();

  const allowed = ["booked", "confirmed", "completed", "cancelled", "no_show"] as const;
  type AppointmentStatus = (typeof allowed)[number];

  if (!allowed.includes(body.status as AppointmentStatus)) {
    return c.json(
      {
        error: "invalid_status",
        message: `status must be one of: ${allowed.join(", ")}`,
      },
      400,
    );
  }

  const [appt] = await db
    .update(appointments)
    .set({ status: body.status as AppointmentStatus })
    .where(and(eq(appointments.id, apptId), eq(appointments.businessId, businessId)))
    .returning();

  if (!appt) return c.json({ error: "not_found" }, 404);

  // Визит завершён — обновляем CRM-счётчики клиента
  if (body.status === "completed") {
    const [service] = await db
      .select()
      .from(services)
      .where(eq(services.id, appt.serviceId));
    const priceCents = service?.priceCents ?? 0;

    const [client] = await db
      .select()
      .from(clients)
      .where(eq(clients.id, appt.clientId));

    if (client) {
      await db
        .update(clients)
        .set({
          visits: client.visits + 1,
          totalSpentCents: client.totalSpentCents + priceCents,
          lastVisitAt: appt.startAt,
        })
        .where(eq(clients.id, appt.clientId));
    }
  }

  // Запись отменена — уведомляем первого в очереди ожидания на этот слот
  if (body.status === "cancelled") {
    await handleSlotFreed({
      businessId,
      serviceId: appt.serviceId,
      staffId: appt.staffId,
      startAt: appt.startAt,
      endAt: appt.endAt,
    });
  }

  return c.json({ appointment: appt });
});

// ---------- Шаблоны уведомлений ----------
//
// Шаблоны создаются автоматически при регистрации бизнеса (см. POST /me/businesses).
// Здесь владелец только читает и редактирует переводы - тип (type) менять нельзя,
// он жёстко привязан к событию в системе уведомлений.
//
// translations - объект вида { "ru": "...", "en": "...", ... }.
// Владелец редактирует только нужные ему языки - остальные не трогаются (merge, не replace).
meRoutes.get("/businesses/:id/templates", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");

  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const rows = await db
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.businessId, businessId));

  return c.json({ templates: rows });
});

meRoutes.patch("/businesses/:id/templates/:type", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const type = c.req.param("type");

  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ translations: Record<string, string> }>();

  if (!body.translations || typeof body.translations !== "object" || Array.isArray(body.translations)) {
    return c.json({ error: "invalid_input", message: "translations must be an object { locale: text }" }, 400);
  }

  // Ищем существующий шаблон
  const [existing] = await db
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.businessId, businessId), eq(messageTemplates.type, type)));

  if (!existing) return c.json({ error: "not_found" }, 404);

  // Merge: не затираем языки, которые владелец не передал - только обновляем переданные.
  const merged = { ...existing.translations, ...body.translations };

  const [updated] = await db
    .update(messageTemplates)
    .set({ translations: merged })
    .where(and(eq(messageTemplates.businessId, businessId), eq(messageTemplates.type, type)))
    .returning();

  return c.json({ template: updated });
});

// ---------- Команда бизнеса (businessMembers) ----------
//
// businessMembers - это таблица ДОСТУПА к дашборду (кто может заходить в панель управления).
// Не путать с staff - это сотрудники для записи клиентов (мастера, врачи и т.д.).
// Один человек может быть и в members (доступ к дашборду), и в staff (ведёт записи).
//
// Добавить нового члена команды можно только по email - пользователь должен уже
// быть зарегистрирован в системе. Это сознательное ограничение MVP: не хотим
// реализовывать инвайт-ссылки и pending-состояния прямо сейчас.
meRoutes.get("/businesses/:id/members", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");

  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const members = await db
    .select()
    .from(businessMembers)
    .where(eq(businessMembers.businessId, businessId));

  // Обогащаем email и именем - фронт показывает их в таблице команды.
  const enriched = await Promise.all(
    members.map(async (m) => {
      const [user] = await db.select().from(users).where(eq(users.id, m.userId));
      return {
        id: m.id,
        userId: m.userId,
        role: m.role,
        name: user?.name ?? "—",
        email: user?.email ?? "—",
      };
    })
  );

  return c.json({ members: enriched });
});

meRoutes.post("/businesses/:id/members", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");

  // Добавлять в команду может только owner или administrator
  const membership = await assertMember(userId, businessId);
  if (!membership) return c.json({ error: "forbidden" }, 403);
  if (!["owner", "administrator"].includes(membership.role)) {
    return c.json({ error: "insufficient_role", message: "Only owner or administrator can add members" }, 403);
  }

  const body = await c.req.json<{ email: string; role?: string }>();
  if (!body.email) return c.json({ error: "invalid_input", message: "email is required" }, 400);

  const allowedRoles = ["administrator", "manager", "employee"] as const;
  type MemberRole = (typeof allowedRoles)[number];
  const role: MemberRole = allowedRoles.includes(body.role as MemberRole)
    ? (body.role as MemberRole)
    : "employee";

  // Ищем пользователя по email
  const [targetUser] = await db
    .select()
    .from(users)
    .where(eq(users.email, body.email.toLowerCase()));

  if (!targetUser) {
    return c.json(
      { error: "user_not_found", message: "No user with this email. They must register first." },
      404
    );
  }

  // Проверяем, не состоит ли уже в команде
  const [alreadyMember] = await db
    .select()
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.businessId, businessId),
        eq(businessMembers.userId, targetUser.id)
      )
    );

  if (alreadyMember) {
    return c.json({ error: "already_member" }, 409);
  }

  const [newMember] = await db
    .insert(businessMembers)
    .values({ businessId, userId: targetUser.id, role })
    .returning();

  return c.json({
    member: {
      id: newMember.id,
      userId: newMember.userId,
      role: newMember.role,
      name: targetUser.name,
      email: targetUser.email,
    },
  });
});

meRoutes.delete("/businesses/:id/members/:memberId", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const memberId = c.req.param("memberId");

  const membership = await assertMember(userId, businessId);
  if (!membership) return c.json({ error: "forbidden" }, 403);
  if (!["owner", "administrator"].includes(membership.role)) {
    return c.json({ error: "insufficient_role" }, 403);
  }

  // Нельзя удалить owner-а из его собственного бизнеса
  const [target] = await db
    .select()
    .from(businessMembers)
    .where(
      and(
        eq(businessMembers.id, memberId),
        eq(businessMembers.businessId, businessId)
      )
    );

  if (!target) return c.json({ error: "not_found" }, 404);
  if (target.role === "owner") {
    return c.json({ error: "cannot_remove_owner", message: "Owner cannot be removed from the business" }, 400);
  }

  await db
    .delete(businessMembers)
    .where(
      and(
        eq(businessMembers.id, memberId),
        eq(businessMembers.businessId, businessId)
      )
    );

  return c.json({ ok: true });
});

// ---------- Подписка ----------
//
// Возвращает текущий статус подписки бизнеса - фронт дашборда показывает
// баннер "триал заканчивается через X дней" и блокирует фичи при expired/cancelled.
// Детали платежей (история списаний) - отдельный эндпоинт, здесь только текущий статус.
meRoutes.get("/businesses/:id/subscription", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");

  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.businessId, businessId));

  if (!subscription) {
    // Бизнес только создан и ещё не прошёл через активацию триала -
    // возвращаем null, фронт покажет онбординг-шаг подключения оплаты.
    return c.json({ subscription: null });
  }

  // Считаем дни до конца триала/периода - удобнее чем парсить даты на фронте.
  const now = Date.now();
  const trialDaysLeft =
    subscription.status === "trial"
      ? Math.max(0, Math.ceil((subscription.trialEndsAt.getTime() - now) / 86_400_000))
      : null;

  const periodDaysLeft =
    subscription.currentPeriodEndsAt
      ? Math.max(0, Math.ceil((subscription.currentPeriodEndsAt.getTime() - now) / 86_400_000))
      : null;

  return c.json({
    subscription: {
      id: subscription.id,
      plan: subscription.plan,
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt,
      trialDaysLeft,
      currentPeriodEndsAt: subscription.currentPeriodEndsAt,
      periodDaysLeft,
      hasPaymentMethod: Boolean(subscription.yookassaPaymentMethodId),
      cancelledAt: subscription.cancelledAt,
      createdAt: subscription.createdAt,
    },
  });
});

// ---------- CRM: карточка клиента ----------
//
// GET - полная карточка: контакты + история записей + CRM-поля (теги, заметки).
// PATCH - владелец редактирует только CRM-поля (теги, заметки).
//         Контактные данные (phone, email, telegramChatId) клиент задаёт сам
//         при бронировании - владелец их не меняет, чтобы не сломать доставку уведомлений.
meRoutes.get("/businesses/:id/clients/:clientId", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const clientId = c.req.param("clientId");

  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)));

  if (!client) return c.json({ error: "not_found" }, 404);

  // История записей клиента - обогащаем названиями услуги и сотрудника
  const clientAppts = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.clientId, clientId), eq(appointments.businessId, businessId)));

  const enrichedAppts = await Promise.all(
    clientAppts.map(async (a) => {
      const [service] = await db.select().from(services).where(eq(services.id, a.serviceId));
      const [staffMember] = await db.select().from(staff).where(eq(staff.id, a.staffId));
      return {
        id: a.id,
        startAt: a.startAt,
        endAt: a.endAt,
        status: a.status,
        serviceName: service?.name.en ?? service?.name.ru ?? "—",
        staffName: staffMember?.name ?? "—",
        priceCents: service?.priceCents ?? 0,
        currency: service?.currency ?? "",
      };
    })
  );

  enrichedAppts.sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());

  return c.json({
    client,
    appointments: enrichedAppts,
  });
});

meRoutes.patch("/businesses/:id/clients/:clientId", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const clientId = c.req.param("clientId");

  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    tags?: string[];
    notes?: string[];
  }>();

  // Разрешаем менять только CRM-поля - контакты клиент задаёт сам при бронировании.
  const patch: Record<string, unknown> = {};
  if (Array.isArray(body.tags)) patch.tags = body.tags;
  if (Array.isArray(body.notes)) patch.notes = body.notes;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "invalid_input", message: "Provide tags or notes to update" }, 400);
  }

  const [updated] = await db
    .update(clients)
    .set(patch)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)))
    .returning();

  if (!updated) return c.json({ error: "not_found" }, 404);

  return c.json({ client: updated });
});

// POST /me/businesses - онбординг: владелец создаёт СВОЮ компанию с нуля.
// slug генерируется автоматически из названия - никакого "ivan" по умолчанию.
meRoutes.post("/businesses", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json<{ name: string; niche: string; timezone: string }>();

  if (!body.name || !body.niche || !body.timezone) {
    return c.json({ error: "invalid_input", message: "name, niche and timezone are required" }, 400);
  }

  const slug = await generateUniqueSlug(body.name);

  const [business] = await db
    .insert(businesses)
    .values({
      ownerId: userId,
      slug,
      name: body.name,
      niche: body.niche,
      timezone: body.timezone,
      channelPriority: ["telegram", "whatsapp", "viber", "messenger", "sms", "email"],
      workingHours: {
        1: { start: 600, end: 1200 },
        2: { start: 600, end: 1200 },
        3: { start: 600, end: 1200 },
        4: { start: 600, end: 1200 },
        5: { start: 600, end: 1200 },
        6: null,
        0: null,
      },
    })
    .returning();

  await db.insert(businessMembers).values({ businessId: business.id, userId, role: "owner" });

  // Уведомления должны работать сразу "из коробки" - создаём дефолтные
  // мультиязычные шаблоны, владелец сможет отредактировать их позже.
  await db.insert(messageTemplates).values(
    Object.entries(defaultTemplates).map(([type, translations]) => ({
      businessId: business.id,
      type,
      translations,
    }))
  );

  return c.json({ business });
});

// GET /me/businesses/:id
meRoutes.get("/businesses/:id", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const membership = await assertMember(userId, businessId);
  if (!membership) return c.json({ error: "forbidden" }, 403);

  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!business) return c.json({ error: "not_found" }, 404);
  return c.json({ business, myRole: membership.role });
});

// Расписание работы бизнеса ПО УМОЛЧАНИЮ - используется для всех сотрудников,
// у которых не озадано собственное индивидуальное окн приёма (staff.workingHours = null).
meRoutes.patch("/businesses/:id", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  const membership = await assertMember(userId, businessId);
  if (!membership) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<
    Partial<{ name: string; timezone: string; workingHours: Record<number, { start: number; end: number } | null>; taxPercent: number }>
  >();
  const patch: Record<string, unknown> = {};
  if (body.name) patch.name = body.name;
  if (body.timezone) patch.timezone = body.timezone;
  if (body.workingHours) patch.workingHours = body.workingHours;
  if (body.taxPercent != null) patch.taxPercentBp = Math.round(body.taxPercent * 100);

  const [business] = await db.update(businesses).set(patch).where(eq(businesses.id, businessId)).returning();
  if (!business) return c.json({ error: "not_found" }, 404);

  if (body.workingHours) await invalidateAllAvailability(businessId);

  return c.json({ business });
});

// ---------- Услуги (СВОИ, индивидуальные для каждого бизнеса) ----------

meRoutes.get("/businesses/:id/services", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const rows = await db.select().from(services).where(eq(services.businessId, businessId));
  return c.json({ services: rows });
});

// Владелец вводит название услуги ОДИН раз на своём языке (locale владельца) -
// мы кладём его во все 7 языковых слотов как стартовое значение, чтобы клиент
// в любом случае увидел текст, а не пустоту. Точный перевод на остальные языки -
// доработка на будущее (человеческий перевод/AI-перевод), но продукт уже рабочий.
meRoutes.post("/businesses/:id/services", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    name: string;
    durationMin: number;
    priceCents: number;
    currency: string;
    photoUrl?: string;
  }>();
  if (!body.name || !body.durationMin || body.priceCents == null || !body.currency) {
    return c.json({ error: "invalid_input" }, 400);
  }

  const locales = ["ru", "en", "es", "it", "fr", "kk", "hy"];
  const name = Object.fromEntries(locales.map((l) => [l, body.name]));

  const [service] = await db
    .insert(services)
    .values({
      businessId,
      name,
      durationMin: body.durationMin,
      priceCents: body.priceCents,
      currency: body.currency,
      photoUrl: body.photoUrl,
    })
    .returning();

  return c.json({ service });
});

meRoutes.patch("/businesses/:id/services/:serviceId", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<Partial<{ name: string; durationMin: number; priceCents: number; currency: string; photoUrl: string }>>();
  const patch: Record<string, unknown> = {};
  if (body.durationMin != null) patch.durationMin = body.durationMin;
  if (body.priceCents != null) patch.priceCents = body.priceCents;
  if (body.currency) patch.currency = body.currency;
  if (body.photoUrl !== undefined) patch.photoUrl = body.photoUrl;
  if (body.name) {
    const locales = ["ru", "en", "es", "it", "fr", "kk", "hy"];
    patch.name = Object.fromEntries(locales.map((l) => [l, body.name]));
  }

  const [service] = await db
    .update(services)
    .set(patch)
    .where(and(eq(services.id, c.req.param("serviceId")), eq(services.businessId, businessId)))
    .returning();

  if (!service) return c.json({ error: "not_found" }, 404);
  return c.json({ service });
});

meRoutes.delete("/businesses/:id/services/:serviceId", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  await db
    .delete(services)
    .where(and(eq(services.id, c.req.param("serviceId")), eq(services.businessId, businessId)));
  return c.json({ ok: true });
});

// ---------- Сотрудники ----------

meRoutes.get("/businesses/:id/staff", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const rows = await db.select().from(staff).where(eq(staff.businessId, businessId));
  return c.json({ staff: rows });
});

meRoutes.post("/businesses/:id/staff", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ name: string; serviceIds: string[]; colorHex?: string; photoUrl?: string; commissionPercent?: number }>();
  if (!body.name || !body.serviceIds?.length) return c.json({ error: "invalid_input" }, 400);

  const [member] = await db
    .insert(staff)
    .values({
      businessId,
      name: body.name,
      serviceIds: body.serviceIds,
      colorHex: body.colorHex ?? "#FF4438",
      photoUrl: body.photoUrl,
      commissionPercentBp: body.commissionPercent != null ? Math.round(body.commissionPercent * 100) : 0,
    })
    .returning();

  return c.json({ staff: member });
});

// Индивидуальное окно приёма сотрудника: владелец указывает, в какие дни недели
// и часы этот конкретный сотрудник принимает клиентов (а не "все подряд" по
// умолчанию бизнеса). null для дня = сотрудник в этот день не работает.
// working hours хранятся в минутах от полуночи, как и остальное расписание.
meRoutes.patch("/businesses/:id/staff/:staffId", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<
    Partial<{
      name: string;
      serviceIds: string[];
      colorHex: string;
      photoUrl: string;
      workingHours: Record<number, { start: number; end: number } | null> | null;
      commissionPercent: number;
    }>
  >();

  const patch: Record<string, unknown> = {};
  if (body.name) patch.name = body.name;
  if (body.serviceIds) patch.serviceIds = body.serviceIds;
  if (body.colorHex) patch.colorHex = body.colorHex;
  if (body.photoUrl !== undefined) patch.photoUrl = body.photoUrl;
  if (body.workingHours !== undefined) patch.workingHours = body.workingHours;
  if (body.commissionPercent != null) patch.commissionPercentBp = Math.round(body.commissionPercent * 100);

  const [member] = await db
    .update(staff)
    .set(patch)
    .where(and(eq(staff.id, c.req.param("staffId")), eq(staff.businessId, businessId)))
    .returning();

  if (!member) return c.json({ error: "not_found" }, 404);

  // Расписание изменилось - клиентам публичной страницы нельзя показывать устаревшие свободные окна.
  if (body.workingHours !== undefined) await invalidateAllAvailability(businessId);

  return c.json({ staff: member });
});

meRoutes.delete("/businesses/:id/staff/:staffId", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  await db.delete(staff).where(and(eq(staff.id, c.req.param("staffId")), eq(staff.businessId, businessId)));
  return c.json({ ok: true });
});

// ---------- Записи и клиенты (для дашборда) ----------

meRoutes.get("/businesses/:id/appointments", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const rows = await db.select().from(appointments).where(eq(appointments.businessId, businessId));
  const enriched = await Promise.all(
    rows.map(async (a) => {
      const [client] = await db.select().from(clients).where(eq(clients.id, a.clientId));
      const [service] = await db.select().from(services).where(eq(services.id, a.serviceId));
      const [staffMember] = await db.select().from(staff).where(eq(staff.id, a.staffId));
      return {
        ...a,
        clientName: client?.name,
        clientLocale: client?.detectedLocale, // владелец видит язык клиента, но не задаёт его
        serviceName: service?.name.en,
        staffName: staffMember?.name,
      };
    })
  );
  enriched.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  return c.json({ appointments: enriched });
});

meRoutes.get("/businesses/:id/clients", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const rows = await db.select().from(clients).where(eq(clients.businessId, businessId));
  return c.json({ clients: rows });
});

// ---------- Аналитика ----------
// Отдаём "сырые" агрегаты - графики и .xlsx-отчёт строятся на фронте из этих же данных,
// чтобы не тащить xlsx-генерацию на бэкенд ради одного экспорта.
meRoutes.get("/businesses/:id/analytics", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  if (!business) return c.json({ error: "not_found" }, 404);

  const [apptRows, svcRows, staffRows, clientRows] = await Promise.all([
    db.select().from(appointments).where(eq(appointments.businessId, businessId)),
    db.select().from(services).where(eq(services.businessId, businessId)),
    db.select().from(staff).where(eq(staff.businessId, businessId)),
    db.select().from(clients).where(eq(clients.businessId, businessId)),
  ]);

  const svcById = new Map(svcRows.map((s) => [s.id, s]));
  const staffById = new Map(staffRows.map((s) => [s.id, s]));
  const clientById = new Map(clientRows.map((cl) => [cl.id, cl]));

  // В деньги считаются только реально состоявшиеся/предстоящие записи -
  // отменённые и неявки (no_show) выручку не приносят.
  const isRevenueGenerating = (status: string) => status !== "cancelled" && status !== "no_show";
  const revenueOf = (a: (typeof apptRows)[number]) => svcById.get(a.serviceId)?.priceCents ?? 0;
  const commissionOf = (a: (typeof apptRows)[number]) => {
    const bp = staffById.get(a.staffId)?.commissionPercentBp ?? 0;
    return Math.round((revenueOf(a) * bp) / 10000);
  };

  const countedAppts = apptRows.filter((a) => isRevenueGenerating(a.status));
  const totalRevenueCents = countedAppts.reduce((sum, a) => sum + revenueOf(a), 0);
  const totalCommissionCents = countedAppts.reduce((sum, a) => sum + commissionOf(a), 0);
  const taxCents = Math.round((totalRevenueCents * business.taxPercentBp) / 10000);
  const netProfitCents = totalRevenueCents - taxCents - totalCommissionCents;

  const byDayMap = new Map<string, { date: string; revenueCents: number; appointments: number }>();
  for (const a of countedAppts) {
    const day = new Date(a.startAt).toISOString().slice(0, 10);
    const entry = byDayMap.get(day) ?? { date: day, revenueCents: 0, appointments: 0 };
    entry.revenueCents += revenueOf(a);
    entry.appointments += 1;
    byDayMap.set(day, entry);
  }

  const byServiceMap = new Map<string, { serviceId: string; name: string; revenueCents: number; count: number }>();
  for (const a of countedAppts) {
    const svc = svcById.get(a.serviceId);
    const entry = byServiceMap.get(a.serviceId) ?? {
      serviceId: a.serviceId,
      name: svc?.name.en ?? svc?.name.ru ?? "—",
      revenueCents: 0,
      count: 0,
    };
    entry.revenueCents += revenueOf(a);
    entry.count += 1;
    byServiceMap.set(a.serviceId, entry);
  }

  const byStaffMap = new Map<
    string,
    { staffId: string; name: string; revenueCents: number; commissionCents: number; count: number }
  >();
  for (const a of countedAppts) {
    const member = staffById.get(a.staffId);
    const entry = byStaffMap.get(a.staffId) ?? {
      staffId: a.staffId,
      name: member?.name ?? "—",
      revenueCents: 0,
      commissionCents: 0,
      count: 0,
    };
    entry.revenueCents += revenueOf(a);
    entry.commissionCents += commissionOf(a);
    entry.count += 1;
    byStaffMap.set(a.staffId, entry);
  }

  const noShowCount = apptRows.filter((a) => a.status === "no_show").length;
  const cancelledCount = apptRows.filter((a) => a.status === "cancelled").length;

  return c.json({
    summary: {
      totalRevenueCents,
      taxPercent: business.taxPercentBp / 100,
      taxCents,
      totalCommissionCents,
      netProfitCents,
      totalAppointments: apptRows.length,
      totalClients: clientRows.length,
      avgCheckCents: countedAppts.length ? Math.round(totalRevenueCents / countedAppts.length) : 0,
      noShowCount,
      cancelledCount,
    },
    byDay: [...byDayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byService: [...byServiceMap.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    byStaff: [...byStaffMap.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    // Детальная построчная выгрузка - основа для .xlsx отчёта на фронте.
    rows: apptRows.map((a) => ({
      date: new Date(a.startAt).toISOString().slice(0, 10),
      client: clientById.get(a.clientId)?.name ?? "—",
      service: svcById.get(a.serviceId)?.name.en ?? "—",
      staff: staffById.get(a.staffId)?.name ?? "—",
      status: a.status,
      priceCents: revenueOf(a),
      commissionCents: isRevenueGenerating(a.status) ? commissionOf(a) : 0,
      currency: svcById.get(a.serviceId)?.currency ?? "",
    })),
  });

  
});

// ---------- Маркетинговые рассылки ----------
//
// Только клиенты с telegramChatId могут получить рассылку - остальные каналы
// (WhatsApp, SMS) подключаются позже. При отправке идём последовательно с
// небольшой задержкой чтобы не словить 429 от Telegram.

type CampaignFilters = {
  segment: 'all' | 'inactive' | 'by_tag' | 'top_clients' | 'new_clients';
  inactiveDays?: number;
  tag?: string;
  visitsGte?: number;
};

// Хелпер: фильтрует клиентов по сегменту.
// Возвращает только тех у кого есть telegramChatId - иначе отправить нечем.
async function getSegmentClients(businessId: string, filters: CampaignFilters) {
  const allClients = await db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.businessId, businessId),
        isNotNull(clients.telegramChatId)
      )
    );

  const now = Date.now();

  switch (filters.segment) {
    case 'all':
      return allClients;

    case 'inactive': {
      const days = filters.inactiveDays ?? 30;
      const cutoff = now - days * 86_400_000;
      return allClients.filter(
        (cl) => !cl.lastVisitAt || cl.lastVisitAt.getTime() < cutoff
      );
    }

    case 'by_tag': {
      const tag = filters.tag ?? '';
      return allClients.filter((cl) => cl.tags.includes(tag));
    }

    case 'top_clients': {
      const min = filters.visitsGte ?? 5;
      return allClients.filter((cl) => cl.visits >= min);
    }

    case 'new_clients':
      // Был 1-2 раза - уже попробовал, но ещё не стал постоянным
      return allClients.filter((cl) => cl.visits >= 1 && cl.visits <= 2);

    default:
      return allClients;
  }
}

// Хелпер: подставляет переменные в текст сообщения
function renderCampaignMessage(
  template: string,
  vars: { clientName: string; businessName: string }
): string {
  return template
    .replace(/\{\{clientName\}\}/g, vars.clientName)
    .replace(/\{\{businessName\}\}/g, vars.businessName);
}

// GET /me/businesses/:id/campaigns - история рассылок
meRoutes.get("/businesses/:id/campaigns", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const rows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.businessId, businessId))
    .orderBy(desc(campaigns.createdAt));

  return c.json({ campaigns: rows });
});

// POST /me/businesses/:id/campaigns/preview
// Предварительный просмотр: сколько клиентов попадёт в выборку и кто именно.
// Ничего не отправляет - только считает. Нужен для UI "Получат: 12 клиентов".
meRoutes.post("/businesses/:id/campaigns/preview", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{ filters: CampaignFilters }>();
  if (!body.filters?.segment) {
    return c.json({ error: "invalid_input", message: "filters.segment is required" }, 400);
  }

  const matched = await getSegmentClients(businessId, body.filters);

  return c.json({
    count: matched.length,
    // Показываем первые 5 имён для превью в UI
    sample: matched.slice(0, 5).map((cl) => ({ id: cl.id, name: cl.name })),
  });
});



// POST /me/businesses/:id/campaigns/send
// Реальная отправка. Создаёт запись в campaigns и шлёт сообщения последовательно.
// Статус в БД обновляется после завершения всей рассылки.
meRoutes.post("/businesses/:id/campaigns/send", async (c) => {
  const userId = c.get("userId") as string;
  const businessId = c.req.param("id");
  if (!(await assertMember(userId, businessId))) return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json<{
    name: string;
    message: string;
    filters: CampaignFilters;
  }>();

  if (!body.name?.trim() || !body.message?.trim() || !body.filters?.segment) {
    return c.json({ error: "invalid_input", message: "name, message and filters.segment are required" }, 400);
  }

  // Проверяем что Telegram-бот подключён - без него отправить невозможно
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId));

  if (!business?.telegramBotToken) {
    return c.json(
      { error: "telegram_not_connected", message: "Подключите Telegram-бота в настройках чтобы делать рассылки" },
      400
    );
  }

  const matched = await getSegmentClients(businessId, body.filters);

  if (matched.length === 0) {
    return c.json({ error: "no_recipients", message: "Ни один клиент не попал в выборку" }, 400);
  }

  // Создаём запись кампании сразу - даже если часть отправок упадёт
  const [campaign] = await db
    .insert(campaigns)
    .values({
      businessId,
      name: body.name.trim(),
      message: body.message.trim(),
      filters: body.filters,
      channel: 'telegram',
      status: 'sending',
      recipientCount: matched.length,
    })
    .returning();

  // Отправляем последовательно - 50ms между запросами чтобы не словить 429
  let sentCount = 0;
  for (const client of matched) {
    if (!client.telegramChatId) continue;
    try {
      const text = renderCampaignMessage(body.message, {
        clientName: client.name,
        businessName: business.name,
      });
      const result = await sendTelegramMessage(
        business.telegramBotToken,
        client.telegramChatId,
        text
      );
      if (result.ok) sentCount++;
    } catch {
      // Один упавший клиент не останавливает всю рассылку
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  // Обновляем итоговый статус
  const [updated] = await db
    .update(campaigns)
    .set({
      status: sentCount > 0 ? 'sent' : 'failed',
      sentCount,
      sentAt: new Date(),
    })
    .where(eq(campaigns.id, campaign.id))
    .returning();

  return c.json({
    campaign: updated,
    result: {
      total: matched.length,
      sent: sentCount,
      failed: matched.length - sentCount,
    },
  });
});

// GET /me/businesses/:id/waitlist — список очереди
meRoutes.get('/businesses/:id/waitlist', async (c) => {
  const userId = c.get('userId') as string;
  const businessId = c.req.param('id');

  if (!(await assertMember(userId, businessId))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const status = c.req.query('status'); // ?status=active|invited|claimed|expired|cancelled

  const rows = await db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.businessId, businessId),
        status ? eq(waitlistEntries.status, status as any) : undefined,
      ),
    )
    .orderBy(desc(waitlistEntries.createdAt));

  // Обогащаем именами клиента и услуги
  const enriched = await Promise.all(
    rows.map(async (entry) => {
      const [[cl], [svc], staffMember] = await Promise.all([
        db.select().from(clients).where(eq(clients.id, entry.clientId)),
        db.select().from(services).where(eq(services.id, entry.serviceId)),
        entry.staffId
          ? db.select().from(staff).where(eq(staff.id, entry.staffId)).then(([r]) => r)
          : Promise.resolve(null),
      ]);

      return {
        ...entry,
        clientName: cl?.name ?? '—',
        serviceName: svc?.name['en'] ?? svc?.name['ru'] ?? '—',
        staffName: staffMember?.name ?? 'Любой',
      };
    }),
  );

  return c.json({ waitlist: enriched });
});

// PATCH /me/businesses/:id/waitlist/:entryId — ручная отмена заявки
meRoutes.patch('/businesses/:id/waitlist/:entryId', async (c) => {
  const userId = c.get('userId') as string;
  const businessId = c.req.param('id');
  const entryId = c.req.param('entryId');

  if (!(await assertMember(userId, businessId))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await c.req.json<{ status: 'cancelled' }>();

  if (body.status !== 'cancelled') {
    return c.json({ error: 'invalid_input', message: 'Only cancellation is allowed' }, 400);
  }

  const [entry] = await db
    .update(waitlistEntries)
    .set({ status: 'cancelled' })
    .where(
      and(
        eq(waitlistEntries.id, entryId),
        eq(waitlistEntries.businessId, businessId),
      ),
    )
    .returning();

  if (!entry) return c.json({ error: 'not_found' }, 404);

  return c.json({ entry });
});

// POST /me/businesses/:id/waitlist/:entryId/notify — принудительно пригласить
meRoutes.post('/businesses/:id/waitlist/:entryId/notify', async (c) => {
  const userId = c.get('userId') as string;
  const businessId = c.req.param('id');
  const entryId = c.req.param('entryId');

  if (!(await assertMember(userId, businessId))) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const [entry] = await db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.id, entryId),
        eq(waitlistEntries.businessId, businessId),
        eq(waitlistEntries.status, 'active'),
      ),
    );

  if (!entry) {
    return c.json({ error: 'not_found_or_not_active' }, 404);
  }

  await handleSlotFreed({
    businessId: entry.businessId,
    serviceId: entry.serviceId,
    staffId: entry.staffId,
    startAt: entry.startAt,
    endAt: entry.endAt,
  });

  return c.json({ ok: true });
});

// В самом начале файла добавьте импорт:

