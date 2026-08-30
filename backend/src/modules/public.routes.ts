import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  businesses,
  services,
  staff as staffTable,
  clients,
  appointments,
} from "../db/schema.js";
import { getAvailability } from "./availability.js";
import { resolveClientLocale } from "../i18n/detectLocale.js";
import { t } from "../i18n/strings.js";
import {
  dispatchNotification,
  scheduleAppointmentReminders,
} from "./notifications.js";
import { redis, invalidateAvailability } from "../db/redis.js";
import type { SupportedLocale } from "../types.js";
import { buildTelegramConnectLink } from "./telegram/telegram.service.js";
import { joinWaitlist, claimInvite, holdKey } from "./waitlist/waitlist.service.js";

export const publicRoutes = new Hono();

publicRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.slug, slug));
  if (!business) return c.json({ error: "not_found" }, 404);

  const locale = resolveClientLocale({
    acceptLanguageHeader: c.req.header("accept-language"),
  });

  const svcRows = await db
    .select()
    .from(services)
    .where(eq(services.businessId, business.id));
  const staffRows = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.businessId, business.id));

  return c.json({
    locale,
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      timezone: business.timezone,
    },
    services: svcRows.map((s) => ({
      id: s.id,
      name: s.name[locale] ?? s.name.en,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
      currency: s.currency,
      photoUrl: s.photoUrl,
    })),
    staff: staffRows.map((s) => ({
      id: s.id,
      name: s.name,
      serviceIds: s.serviceIds,
      colorHex: s.colorHex,
      photoUrl: s.photoUrl,
    })),
    ui: {
      chooseService: t(locale, "chooseService"),
      chooseStaff: t(locale, "chooseStaff"),
      chooseDate: t(locale, "chooseDate"),
      chooseTime: t(locale, "chooseTime"),
      yourName: t(locale, "yourName"),
      yourPhone: t(locale, "yourPhone"),
      confirmBooking: t(locale, "confirmBooking"),
      bookingConfirmedTitle: t(locale, "bookingConfirmedTitle"),
      bookingConfirmedBody: t(locale, "bookingConfirmedBody"),
      noSlotsToday: t(locale, "noSlotsToday"),
      anyStaff: t(locale, "anyStaff"),
      minutes: t(locale, "minutes"),
    },
  });
});

publicRoutes.get("/:slug/availability", async (c) => {
  const slug = c.req.param("slug");
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.slug, slug));
  if (!business) return c.json({ error: "not_found" }, 404);

  const serviceId = c.req.query("serviceId");
  const date = c.req.query("date");
  const staffId = c.req.query("staffId") || undefined;
  if (!serviceId || !date)
    return c.json({ error: "serviceId and date are required" }, 400);

  const slots = await getAvailability({
    businessId: business.id,
    serviceId,
    date,
    staffId,
  });

  // Фильтруем слоты, которые сейчас в HOLD под waitlist-приглашение.
  // Пока клиент не подтвердил или не истёк холд — слот скрыт из публичной выдачи,
  // чтобы его не мог занять кто-то другой через обычное бронирование.
  const availableSlots = await Promise.all(
    slots.map(async (slot: { startAt: string; endAt: string; staffId: string }) => {
      const key = holdKey(
        business.id,
        slot.staffId ?? staffId ?? null,
        new Date(slot.startAt),
        new Date(slot.endAt),
      );
      const isOnHold = await redis.exists(key);
      return isOnHold ? null : slot;
    }),
  );

  return c.json({
    slots: availableSlots.filter(Boolean),
  });
});

publicRoutes.post("/:slug/book", async (c) => {
  const slug = c.req.param("slug");
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.slug, slug));
  if (!business) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<{
    serviceId: string;
    staffId: string;
    startAt: string;
    clientName: string;
    clientPhone: string;
    telegramLanguageCode?: string;
  }>();

  const [service] = await db
    .select()
    .from(services)
    .where(eq(services.id, body.serviceId));
  if (!service) return c.json({ error: "invalid_service" }, 400);

  let [client] = await db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.businessId, business.id),
        eq(clients.phone, body.clientPhone),
      ),
    );

  const locale: SupportedLocale = resolveClientLocale({
    savedLocale: client?.detectedLocale as SupportedLocale | undefined,
    telegramLanguageCode: body.telegramLanguageCode,
    acceptLanguageHeader: c.req.header("accept-language"),
  });

  if (!client) {
    const [created] = await db
      .insert(clients)
      .values({
        businessId: business.id,
        name: body.clientName,
        phone: body.clientPhone,
        detectedLocale: locale,
      })
      .returning();
    client = created;
  }

  const startAt = new Date(body.startAt);
  const endAt = new Date(startAt.getTime() + service.durationMin * 60_000);

  const [appointment] = await db
    .insert(appointments)
    .values({
      businessId: business.id,
      clientId: client.id,
      staffId: body.staffId,
      serviceId: body.serviceId,
      startAt,
      endAt,
      status: "booked",
      source: "public_widget",
    })
    .returning();

  await invalidateAvailability(business.id, body.startAt.slice(0, 10));

  const [staffMember] = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, body.staffId));

  const notification = await dispatchNotification({
    businessId: business.id,
    clientId: client.id,
    templateType: "booking_confirmed",
    channelPriority: business.channelPriority as any,
    telegramBotToken: business.telegramBotToken,
    vars: {
      clientName: client.name,
      time: startAt.toLocaleString(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
      staffName: staffMember?.name ?? "",
    },
  });

  await scheduleAppointmentReminders(appointment.id, startAt.toISOString());

  const telegramConnectUrl =
    business.telegramBotUsername && !client.telegramChatId
      ? buildTelegramConnectLink(business.telegramBotUsername, client.id)
      : null;

  return c.json({ appointment, clientLocale: locale, notification, telegramConnectUrl });
});

// ----------------------------------------------------------------
// Waitlist: публичные эндпоинты
// ----------------------------------------------------------------

// POST /public/waitlist — записаться в очередь ожидания
publicRoutes.post("/waitlist", async (c) => {
  const body = await c.req.json<{
    businessId: string;
    serviceId: string;
    staffId?: string | null;
    startAt: string;
    endAt: string;
    priority?: number;
    client: {
      id?: string;
      name: string;
      phone?: string;
      email?: string;
      telegramChatId?: string;
      locale?: string;
    };
  }>();

  if (
    !body.businessId ||
    !body.serviceId ||
    !body.startAt ||
    !body.endAt ||
    !body.client?.name
  ) {
    return c.json({ error: "invalid_input" }, 400);
  }

  // Ищем существующего клиента по любому из контактов, иначе создаём нового
  let clientId = body.client.id ?? null;

  if (!clientId) {
    let existing: typeof clients.$inferSelect | null = null;

    if (body.client.telegramChatId) {
      const [row] = await db
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.businessId, body.businessId),
            eq(clients.telegramChatId, body.client.telegramChatId),
          ),
        );
      existing = row ?? null;
    }

    if (!existing && body.client.email) {
      const [row] = await db
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.businessId, body.businessId),
            eq(clients.email, body.client.email),
          ),
        );
      existing = row ?? null;
    }

    if (!existing && body.client.phone) {
      const [row] = await db
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.businessId, body.businessId),
            eq(clients.phone, body.client.phone),
          ),
        );
      existing = row ?? null;
    }

    if (existing) {
      clientId = existing.id;
    } else {
      const [created] = await db
        .insert(clients)
        .values({
          businessId: body.businessId,
          name: body.client.name,
          phone: body.client.phone ?? null,
          email: body.client.email ?? null,
          telegramChatId: body.client.telegramChatId ?? null,
          detectedLocale: body.client.locale ?? "ru",
          preferredChannel: null,
        })
        .returning();
      clientId = created.id;
    }
  }

  const entry = await joinWaitlist({
    businessId: body.businessId,
    clientId: clientId!,
    serviceId: body.serviceId,
    staffId: body.staffId ?? null,
    startAt: new Date(body.startAt),
    endAt: new Date(body.endAt),
    priority: body.priority,
  });

  return c.json({ entryId: entry.id });
});

// GET /public/waitlist/claim/:token — переход по ссылке из уведомления
// Всегда редиректит на фронт — статус в query params
publicRoutes.get("/waitlist/claim/:token", async (c) => {
  const token = c.req.param("token");
  const result = await claimInvite(token);

  if (result.ok) {
    const url = `${process.env.PUBLIC_BASE_URL}/waitlist/claim-result?status=ok&appointmentId=${encodeURIComponent(result.appointmentId)}`;
    return c.redirect(url, 302);
  } else {
    const url = `${process.env.PUBLIC_BASE_URL}/waitlist/claim-result?status=error&reason=${encodeURIComponent(result.reason)}`;
    return c.redirect(url, 302);
  }
});