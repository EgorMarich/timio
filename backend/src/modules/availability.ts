import { and, eq, ne, gte, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { appointments, businesses, services, staff as staffTable } from "../db/schema.js";
import { availabilityCacheKey, getCachedAvailability, setCachedAvailability } from "../db/redis.js";

export interface Slot {
  startAt: string;
  endAt: string;
  staffId: string;
}

const STEP_MIN = 15;

function minutesToDate(day: Date, minutes: number): Date {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutes);
  return d;
}

export async function getAvailability(params: {
  businessId: string;
  serviceId: string;
  date: string;
  staffId?: string;
}): Promise<Slot[]> {
  const cacheKey = availabilityCacheKey(params);
  const cached = await getCachedAvailability(cacheKey);
  if (cached) return cached;

  const [business] = await db.select().from(businesses).where(eq(businesses.id, params.businessId));
  const [service] = await db.select().from(services).where(eq(services.id, params.serviceId));
  if (!business || !service) return [];

  const day = new Date(params.date + "T00:00:00");
  const weekday = day.getDay();
  const dayEnd = new Date(day);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const candidateStaff = await db
    .select()
    .from(staffTable)
    .where(eq(staffTable.businessId, params.businessId));

  const eligibleStaff = candidateStaff.filter(
    (s) => s.serviceIds.includes(params.serviceId) && (!params.staffId || s.id === params.staffId)
  );

  const existingAppointments = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, params.businessId),
        ne(appointments.status, "cancelled"),
        gte(appointments.startAt, day),
        lt(appointments.startAt, dayEnd)
      )
    );

  const slots: Slot[] = [];

  for (const member of eligibleStaff) {
    const hours = member.workingHours ?? business.workingHours;
    const window = hours?.[weekday];
    if (!window) continue;

    for (let m = window.start; m + service.durationMin <= window.end; m += STEP_MIN) {
      const startAt = minutesToDate(day, m);
      const endAt = minutesToDate(day, m + service.durationMin);
      if (startAt.getTime() < Date.now()) continue;

      const overlaps = existingAppointments.some(
        (a) =>
          a.staffId === member.id &&
          new Date(a.startAt) < endAt &&
          new Date(a.endAt) > startAt
      );
      if (overlaps) continue;

      slots.push({ startAt: startAt.toISOString(), endAt: endAt.toISOString(), staffId: member.id });
    }
  }

  slots.sort((a, b) => a.startAt.localeCompare(b.startAt));
  await setCachedAvailability(cacheKey, slots);
  return slots;
}
