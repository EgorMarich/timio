// НОВЫЙ ФАЙЛ (модуль подписок)
//
// Тарифы Timio:
//  - basic:    до 5 сотрудников включительно, фиксированная цена
//  - business: включает базовую цену + доплата за каждого сотрудника СВЕРХ 5
//
// Суммы храним в копейках (integer), как и везде в проекте (priceCents,
// taxPercentBp и т.д.) - никакой плавающей точки в деньгах.

export type SubscriptionPlan = 'basic' | 'business';

export const PLAN_LIMITS = {
  basic: { includedStaff: 5 },
  business: { includedStaff: 5 },
} as const;

// Цены - вынесены отдельными константами, чтобы легко поменять без поиска по коду.
export const PLAN_PRICING = {
  basic: {
    baseCents: 199900, // 1990 ₽/мес фиксированно, до 5 сотрудников
  },
  business: {
    baseCents: 279900, // 2799 ₽/мес база (тоже включает первые 5 сотрудников)
    perExtraStaffCents: 69000, // 690 ₽/мес за каждого сотрудника сверх 5
  },
} as const;

export const TRIAL_PERIOD_DAYS = 14;
export const DEFAULT_CURRENCY = 'RUB';

/**
 * Считает ежемесячную сумму подписки для бизнеса с данным количеством
 * сотрудников. Для "basic" количество сотрудников не влияет на цену -
 * если бизнес вырос за пределы 5 человек, ему нужно предложить перейти
 * на "business" (проверка лимита - отдельно, см. subscription.service.ts).
 */
export function calculateMonthlyAmountCents(plan: SubscriptionPlan, staffCount: number): number {
  if (plan === 'basic') {
    return PLAN_PRICING.basic.baseCents;
  }

  const extraStaff = Math.max(0, staffCount - PLAN_LIMITS.business.includedStaff);
  return PLAN_PRICING.business.baseCents + extraStaff * PLAN_PRICING.business.perExtraStaffCents;
}

export function isStaffCountWithinBasicLimit(staffCount: number): boolean {
  return staffCount <= PLAN_LIMITS.basic.includedStaff;
}
