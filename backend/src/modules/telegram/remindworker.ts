// НОВЫЙ ФАЙЛ (модуль уведомлений)
//
// До этого файла scheduleAppointmentReminders() клала задачи в Redis ZSET
// (reminders:scheduled), но НИ ОДИН процесс их не забирал - напоминания
// фактически никогда не отправлялись. Этот воркер - недостающее звено:
// периодически вызывает popDueReminders() и реально дёргает dispatchNotification
// для каждого "созревшего" напоминания.
//
// Как и subscriptionCron.ts - лёгкий setInterval-поллер, а не BullMQ-воркер,
// чтобы не добавлять новую инфраструктуру ради одной задачи (см. тот же
// комментарий в subscriptionCron.ts).

import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { appointments, businesses, clients, services, staff } from "../../db/schema.js";
import { popDueReminders } from "../../db/redis.js";
import { dispatchNotification } from "../notifications.js";

const POLL_INTERVAL_MS = Number(process.env.REMINDER_WORKER_INTERVAL_MS ?? 60 * 1000); // раз в минуту

interface ReminderJob {
  appointmentId: string;
  fireAt: number;
  kind: string; // "reminder_24h" | "reminder_3h" | "reminder_15m"
}

/** Один проход: забрать все "созревшие" напоминания и попытаться их отправить. */
export async function runReminderWorkerTick() {
  const jobs = (await popDueReminders()) as ReminderJob[];
  let sent = 0;
  let skipped = 0;

  for (const job of jobs) {
    const ok = await processReminderJob(job);
    if (ok) sent += 1;
    else skipped += 1;
  }

  return { processed: jobs.length, sent, skipped };
}

async function processReminderJob(job: ReminderJob): Promise<boolean> {
  const [appointment] = await db.select().from(appointments).where(eq(appointments.id, job.appointmentId));
  // Запись могла быть отменена/перенесена/удалена за время ожидания в очереди -
  // тогда напоминание больше не актуально, просто пропускаем без ошибки.
  if (!appointment || appointment.status === "cancelled") return false;

  const [business] = await db.select().from(businesses).where(eq(businesses.id, appointment.businessId));
  const [service] = await db.select().from(services).where(eq(services.id, appointment.serviceId));
  const [staffMember] = await db.select().from(staff).where(eq(staff.id, appointment.staffId));
  const [client] = await db.select().from(clients).where(eq(clients.id, appointment.clientId));
  if (!business || !client) return false;

  const result = await dispatchNotification({
    businessId: business.id,
    clientId: client.id,
    templateType: "reminder",
    channelPriority: business.channelPriority as any,
    telegramBotToken: business.telegramBotToken,
    vars: {
      clientName: client.name,
      time: new Date(appointment.startAt).toLocaleString(client.detectedLocale, { dateStyle: "medium", timeStyle: "short" }),
      staffName: staffMember?.name ?? "",
      serviceName: service?.name?.[client.detectedLocale] ?? service?.name?.en ?? "",
    },
  });

  return Boolean(result);
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startReminderWorker() {
  if (intervalHandle) return;
  // eslint-disable-next-line no-console
  console.log(`[reminder-worker] started, interval ${POLL_INTERVAL_MS}ms`);
  intervalHandle = setInterval(() => {
    runReminderWorkerTick()
      .then((r) => {
        if (r.processed > 0) {
          // eslint-disable-next-line no-console
          console.log(`[reminder-worker] tick: processed=${r.processed} sent=${r.sent} skipped=${r.skipped}`);
        }
      })
      .catch((err) => console.error("[reminder-worker] tick failed:", err));
  }, POLL_INTERVAL_MS);
}

export function stopReminderWorker() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}