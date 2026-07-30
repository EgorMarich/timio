import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { businesses, businessMembers, services, staff, appointments, clients, messageTemplates } from "../db/schema.js";
import { requireAuth } from "./authMiddleware.js";
import { generateUniqueSlug } from "./slug.js";
import { defaultTemplates } from "./defaultTemplates.js";
import { redis, invalidateAllAvailability } from "../db/redis.js";

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
// у которых не задано собственное индивидуальное окно приёма (staff.workingHours = null).
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
