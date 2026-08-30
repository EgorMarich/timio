import { db } from '../../db/client.js';
import {
  businesses,
  clients,
  services,
  messageTemplates,
  waitlistEntries,
  appointments,
  notificationLogs,
} from '../../db/schema.js';
import { and, eq, ne, or, isNull } from 'drizzle-orm';
import { redis, invalidateAllAvailability } from '../../db/redis.js';
import { sendTelegramMessage } from '../telegram/telegram.service.js';
import crypto from 'node:crypto';

const HOLD_MINUTES = Number(process.env.WAITLIST_HOLD_MINUTES ?? 15);

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.FRONTEND_BASE_URL ||
  'http://localhost:3000';

// ----------------------------------------------------------------
// Утилиты
// ----------------------------------------------------------------

function genToken(): string {
  return crypto.randomBytes(32).toString('hex'); // 64 hex символа
}

function holdRedisKey(
  businessId: string,
  staffId: string | null,
  startAt: Date,
  endAt: Date,
): string {
  return `waitlist:hold:${businessId}:${staffId ?? 'any'}:${startAt.toISOString()}:${endAt.toISOString()}`;
}

function formatTimeRange(
  startAt: Date,
  endAt: Date,
  timezone: string,
  locale: string,
): { start: string; end: string } {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  };
  return {
    start: new Intl.DateTimeFormat(locale, opts).format(startAt),
    end: new Intl.DateTimeFormat(locale, opts).format(endAt),
  };
}

async function getTemplate(
  businessId: string,
  type: string,
  locale: string,
): Promise<{ templateId: string; text: string } | null> {
  const [tpl] = await db
    .select()
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.businessId, businessId),
        eq(messageTemplates.type, type),
      ),
    );

  if (!tpl) return null;

  const text =
    tpl.translations[locale] ??
    tpl.translations['ru'] ??
    tpl.translations['en'] ??
    Object.values(tpl.translations)[0];

  return { templateId: tpl.id, text };
}

function renderTemplate(
  text: string,
  vars: Record<string, string | number>,
): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replaceAll(`{{${key}}}`, String(value)),
    text,
  );
}

// ----------------------------------------------------------------
// Типы
// ----------------------------------------------------------------

export type WaitlistSlot = {
  businessId: string;
  serviceId: string;
  staffId: string | null;
  startAt: Date;
  endAt: Date;
};

// ----------------------------------------------------------------
// Публичные функции
// ----------------------------------------------------------------

/** Добавить клиента в очередь на конкретный слот */
export async function joinWaitlist(input: {
  businessId: string;
  clientId: string;
  serviceId: string;
  staffId?: string | null;
  startAt: Date;
  endAt: Date;
  priority?: number;
}) {
  const token = genToken();

  const [entry] = await db
    .insert(waitlistEntries)
    .values({
      businessId: input.businessId,
      clientId: input.clientId,
      serviceId: input.serviceId,
      staffId: input.staffId ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      status: 'active',
      confirmationToken: token,
      priority: input.priority ?? 0,
    })
    .returning();

  return entry;
}

/**
 * Вызывается при отмене записи.
 * Находит первого подходящего в очереди и отправляет ему приглашение.
 */
export async function handleSlotFreed(slot: WaitlistSlot): Promise<void> {
  const candidates = await db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.businessId, slot.businessId),
        eq(waitlistEntries.serviceId, slot.serviceId),
        eq(waitlistEntries.startAt, slot.startAt),
        eq(waitlistEntries.endAt, slot.endAt),
        eq(waitlistEntries.status, 'active'),
        // Точное совпадение сотрудника ИЛИ "любой" (staffId = null)
        or(
          eq(waitlistEntries.staffId, slot.staffId as string),
          isNull(waitlistEntries.staffId),
        ),
      ),
    );

  if (!candidates.length) return;

  // Сортировка: точный сотрудник → приоритет по убыванию → дата по возрастанию
  candidates.sort((a, b) => {
    const aPref = a.staffId === slot.staffId ? 0 : 1;
    const bPref = b.staffId === slot.staffId ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  await inviteEntry(candidates[0], slot);
}

/**
 * Обрабатывает переход по ссылке-приглашению из уведомления.
 * Проверяет токен → создаёт запись → редиректит на фронт.
 */
export async function claimInvite(token: string): Promise<
  | { ok: true; appointmentId: string; redirectUrl: string }
  | { ok: false; reason: string; redirectUrl: string }
> {
  const failRedirect = (reason: string) => ({
    ok: false as const,
    reason,
    redirectUrl: `${PUBLIC_BASE_URL}/waitlist/result?status=error&reason=${reason}`,
  });

  const [entry] = await db
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.confirmationToken, token),
        eq(waitlistEntries.status, 'invited'),
      ),
    );

  if (!entry) return failRedirect('invalid_or_not_invited');

  // Проверяем, не истёк ли холд
  if (!entry.holdExpiresAt || entry.holdExpiresAt.getTime() < Date.now()) {
    await db
      .update(waitlistEntries)
      .set({ status: 'expired' })
      .where(eq(waitlistEntries.id, entry.id));

    await redis.del(
      holdRedisKey(entry.businessId, entry.staffId, entry.startAt, entry.endAt),
    );

    return failRedirect('expired');
  }

  // Проверяем, что слот всё ещё свободен
  const [conflict] = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, entry.businessId),
        eq(appointments.staffId, entry.staffId as string),
        eq(appointments.startAt, entry.startAt),
        eq(appointments.endAt, entry.endAt),
        ne(appointments.status, 'cancelled'),
        ne(appointments.status, 'no_show'),
      ),
    );

  if (conflict) {
    // Слот успели занять — зовём следующего
    await handleSlotFreed({
      businessId: entry.businessId,
      serviceId: entry.serviceId,
      staffId: entry.staffId,
      startAt: entry.startAt,
      endAt: entry.endAt,
    });
    return failRedirect('already_taken');
  }

  // Транзакция: создаём запись + помечаем заявку как claimed
  const { appt } = await db.transaction(async (tx) => {
    const [appt] = await tx
      .insert(appointments)
      .values({
        businessId: entry.businessId,
        clientId: entry.clientId,
        staffId: entry.staffId!,
        serviceId: entry.serviceId,
        startAt: entry.startAt,
        endAt: entry.endAt,
        status: 'booked',
        source: 'waitlist',
      })
      .returning();

    await tx
      .update(waitlistEntries)
      .set({ status: 'claimed' })
      .where(eq(waitlistEntries.id, entry.id));

    return { appt };
  });

  // Чистим hold из Redis и инвалидируем доступность
  await redis.del(
    holdRedisKey(entry.businessId, entry.staffId, entry.startAt, entry.endAt),
  );
  await invalidateAllAvailability(entry.businessId);

  // Отправляем подтверждение клиенту
  await sendConfirmationNotification(entry, appt.id);

  return {
    ok: true,
    appointmentId: appt.id,
    redirectUrl: `${PUBLIC_BASE_URL}/waitlist/result?status=confirmed&appointmentId=${appt.id}`,
  };
}

/**
 * Вызывается воркером каждую минуту.
 * Снимает просроченные холды и зовёт следующего в очереди.
 */
export async function sweepExpiredInvites(): Promise<void> {
  const now = new Date();

  const expired = await db
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.status, 'invited'));

  for (const entry of expired) {
    if (!entry.holdExpiresAt || entry.holdExpiresAt.getTime() > now.getTime()) {
      continue;
    }

    // Помечаем как expired
    await db
      .update(waitlistEntries)
      .set({ status: 'expired' })
      .where(eq(waitlistEntries.id, entry.id));

    // Чистим Redis hold
    await redis.del(
      holdRedisKey(entry.businessId, entry.staffId, entry.startAt, entry.endAt),
    );

    // Зовём следующего по тому же слоту
    await handleSlotFreed({
      businessId: entry.businessId,
      serviceId: entry.serviceId,
      staffId: entry.staffId,
      startAt: entry.startAt,
      endAt: entry.endAt,
    });
  }
}

// ----------------------------------------------------------------
// Внутренние функции
// ----------------------------------------------------------------

async function inviteEntry(
  entry: typeof waitlistEntries.$inferSelect,
  slot: WaitlistSlot,
): Promise<void> {
  const holdUntil = new Date(Date.now() + HOLD_MINUTES * 60_000);
  const key = holdRedisKey(slot.businessId, slot.staffId, slot.startAt, slot.endAt);

  // Ставим холд в Redis
  await redis.set(key, entry.id, { EX: HOLD_MINUTES * 60 });

  const [[biz], [cl], [svc]] = await Promise.all([
    db.select().from(businesses).where(eq(businesses.id, slot.businessId)),
    db.select().from(clients).where(eq(clients.id, entry.clientId)),
    db.select().from(services).where(eq(services.id, slot.serviceId)),
  ]);

  if (!biz || !cl || !svc) return;

  const locale = cl.detectedLocale || 'ru';
  const { start, end } = formatTimeRange(slot.startAt, slot.endAt, biz.timezone, locale);
  const link = `${PUBLIC_BASE_URL}/public/waitlist/claim/${entry.confirmationToken}`;
  const tpl = await getTemplate(slot.businessId, 'waitlist.invite', locale);

  const text = tpl
    ? renderTemplate(tpl.text, {
        start,
        end,
        service: svc.name[locale] ?? svc.name['en'] ?? svc.name['ru'] ?? '—',
        link,
        ttlMin: HOLD_MINUTES,
      })
    : `Освободилось место ${start}–${end}. Подтвердите: ${link}`;

  const channelAttempts: string[] = [];

  // Идём по каналам в порядке приоритета бизнеса
  for (const channel of biz.channelPriority) {
    const alreadySent = channelAttempts.some(
      (ch) => notificationLogs && ch === channel,
    );
    if (alreadySent) break;

    if (channel === 'telegram') {
      if (!biz.telegramBotToken || !cl.telegramChatId) continue;

      channelAttempts.push('telegram');

      try {
        const res = await sendTelegramMessage(
          biz.telegramBotToken,
          cl.telegramChatId,
          text,
        );

        await db.insert(notificationLogs).values({
          clientId: cl.id,
          appointmentId: null,
          event: 'waitlist.invite',
          templateId: tpl?.templateId ?? null,
          channel: 'telegram',
          attemptedChannels: [...channelAttempts],
          status: res.ok ? 'sent' : 'failed',
          renderedText: text,
          sentAt: res.ok ? new Date() : null,
          locale,
        });

        if (res.ok) break; // Успешно отправили — остальные каналы не нужны
      } catch (err) {
        await db.insert(notificationLogs).values({
          clientId: cl.id,
          appointmentId: null,
          event: 'waitlist.invite',
          templateId: tpl?.templateId ?? null,
          channel: 'telegram',
          attemptedChannels: [...channelAttempts],
          status: 'failed',
          renderedText: text,
          error: (err as Error).message,
          locale,
        });
      }
    } else {
      // email / sms / whatsapp / viber / messenger
      // Каналы без реализации — логируем как pending для будущих интеграций
      const hasContact =
        (channel === 'email' && !!cl.email) ||
        (['sms', 'whatsapp', 'viber'].includes(channel) && !!cl.phone);

      channelAttempts.push(channel);

      await db.insert(notificationLogs).values({
        clientId: cl.id,
        appointmentId: null,
        event: 'waitlist.invite',
        templateId: tpl?.templateId ?? null,
        channel: channel as any,
        attemptedChannels: [...channelAttempts],
        status: hasContact ? 'pending' : 'skipped',
        renderedText: text,
        locale,
      });
    }
  }

  // Обновляем статус заявки
  await db
    .update(waitlistEntries)
    .set({
      status: 'invited',
      inviteSentAt: new Date(),
      holdExpiresAt: holdUntil,
      channelAttempts,
    })
    .where(eq(waitlistEntries.id, entry.id));
}

async function sendConfirmationNotification(
  entry: typeof waitlistEntries.$inferSelect,
  appointmentId: string,
): Promise<void> {
  const [[biz], [cl], [svc]] = await Promise.all([
    db.select().from(businesses).where(eq(businesses.id, entry.businessId)),
    db.select().from(clients).where(eq(clients.id, entry.clientId)),
    db.select().from(services).where(eq(services.id, entry.serviceId)),
  ]);

  if (!biz || !cl || !svc) return;

  const locale = cl.detectedLocale || 'ru';
  const { start, end } = formatTimeRange(entry.startAt, entry.endAt, biz.timezone, locale);
  const tpl = await getTemplate(entry.businessId, 'waitlist.confirmed', locale);

  const text = tpl
    ? renderTemplate(tpl.text, {
        start,
        end,
        service: svc.name[locale] ?? svc.name['en'] ?? svc.name['ru'] ?? '—',
      })
    : `Запись подтверждена: ${start}–${end}.`;

  if (!biz.telegramBotToken || !cl.telegramChatId) return;

  try {
    const res = await sendTelegramMessage(
      biz.telegramBotToken,
      cl.telegramChatId,
      text,
    );

    await db.insert(notificationLogs).values({
      clientId: cl.id,
      appointmentId,
      event: 'waitlist.confirmed',
      templateId: tpl?.templateId ?? null,
      channel: 'telegram',
      attemptedChannels: ['telegram'],
      status: res.ok ? 'sent' : 'failed',
      renderedText: text,
      sentAt: res.ok ? new Date() : null,
      locale,
    });
  } catch (err) {
    await db.insert(notificationLogs).values({
      clientId: cl.id,
      appointmentId,
      event: 'waitlist.confirmed',
      templateId: tpl?.templateId ?? null,
      channel: 'telegram',
      attemptedChannels: ['telegram'],
      status: 'failed',
      renderedText: text,
      error: (err as Error).message,
      locale,
    });
  }
}