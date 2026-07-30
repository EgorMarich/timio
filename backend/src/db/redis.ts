import { Redis } from "ioredis";

export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

// Кэш свободных слотов: считать доступность на лету при каждом запросе
// виджета дорого при высокой нагрузке (полный обход appointments по businessId+date).
// Кэшируем результат на короткое TTL и инвалидируем при любом изменении
// расписания (новая запись/отмена/перенос) для этой пары business+date.
const AVAILABILITY_TTL_SEC = 30;

export function availabilityCacheKey(params: {
  businessId: string;
  serviceId: string;
  date: string;
  staffId?: string;
}) {
  return `availability:${params.businessId}:${params.serviceId}:${params.date}:${params.staffId ?? "any"}`;
}

export async function getCachedAvailability(key: string) {
  const raw = await redis.get(key);
  return raw ? JSON.parse(raw) : null;
}

export async function setCachedAvailability(key: string, value: unknown) {
  await redis.set(key, JSON.stringify(value), "EX", AVAILABILITY_TTL_SEC);
}

export async function invalidateAvailability(businessId: string, date: string) {
  const pattern = `availability:${businessId}:*:${date}:*`;
  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(...keys);
}

// Расписание (рабочие окна сотрудника/бизнеса) влияет на доступность СРАЗУ на
// все даты, а не на одну - при его изменении сбрасываем весь кэш бизнеса целиком.
export async function invalidateAllAvailability(businessId: string) {
  const pattern = `availability:${businessId}:*`;
  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(...keys);
}

// Очередь отложенных напоминаний (за 24ч/3ч/15мин до визита).
// В проде это BullMQ поверх того же Redis - здесь минимальный ZSET-планировщик,
// чтобы показать реальный механизм без лишней инфраструктуры в демо.
const REMINDER_QUEUE_KEY = "reminders:scheduled";

export async function scheduleReminder(payload: {
  appointmentId: string;
  fireAt: number; // unix ms
  kind: string;
}) {
  await redis.zadd(REMINDER_QUEUE_KEY, payload.fireAt, JSON.stringify(payload));
}

export async function popDueReminders(now = Date.now()) {
  const due = await redis.zrangebyscore(REMINDER_QUEUE_KEY, 0, now);
  if (due.length) await redis.zrem(REMINDER_QUEUE_KEY, ...due);
  return due.map((raw) => JSON.parse(raw));
}
