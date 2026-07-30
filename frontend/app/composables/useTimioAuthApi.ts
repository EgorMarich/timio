import { useAuthStore } from "../stores/auth";

export type WorkingHours = Record<number, { start: number; end: number } | null>;

export interface OwnedBusiness {
  id: string;
  slug: string;
  name: string;
  niche: string;
  timezone: string;
  workingHours: WorkingHours;
  taxPercentBp: number;
  myRole?: string;
}

export interface OwnedService {
  id: string;
  businessId: string;
  name: Record<string, string>;
  durationMin: number;
  priceCents: number;
  currency: string;
  photoUrl?: string | null;
}

export interface OwnedStaff {
  id: string;
  businessId: string;
  name: string;
  serviceIds: string[];
  colorHex: string;
  photoUrl?: string | null;
  workingHours?: WorkingHours | null;
  commissionPercentBp: number;
}

export interface OwnedAppointment {
  id: string;
  clientId: string;
  staffId: string;
  startAt: string;
  endAt: string;
  status: string;
  clientName?: string;
  clientLocale?: string;
  serviceName?: string;
  staffName?: string;
}

export interface AnalyticsSummary {
  totalRevenueCents: number;
  taxPercent: number;
  taxCents: number;
  totalCommissionCents: number;
  netProfitCents: number;
  totalAppointments: number;
  totalClients: number;
  avgCheckCents: number;
  noShowCount: number;
  cancelledCount: number;
}

export interface AnalyticsResponse {
  summary: AnalyticsSummary;
  byDay: { date: string; revenueCents: number; appointments: number }[];
  byService: { serviceId: string; name: string; revenueCents: number; count: number }[];
  byStaff: { staffId: string; name: string; revenueCents: number; commissionCents: number; count: number }[];
  rows: {
    date: string;
    client: string;
    service: string;
    staff: string;
    status: string;
    priceCents: number;
    commissionCents: number;
    currency: string;
  }[];
}

// ---- Модуль подписок (дописано, существующие типы выше не менялись) ----

export type SubscriptionPlanId = "basic" | "business";
export type SubscriptionStatus = "trial" | "active" | "expired" | "cancelled";

export interface OwnedSubscription {
  id: string;
  businessId: string;
  plan: SubscriptionPlanId;
  status: SubscriptionStatus;
  trialEndsAt: string;
  currentPeriodEndsAt: string | null;
  yookassaPaymentMethodId: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function useTimioAuthApi() {
  const config = useRuntimeConfig();
  const base = config.public.apiBase;
  const auth = useAuthStore();

  async function call<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    try {
      return await $fetch<T>(`${base}${path}`, {
        method: (opts.method as any) ?? "GET",
        body: opts.body,
        headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {},
      });
    } catch (e: any) {
      const status = e?.response?.status ?? e?.statusCode ?? 0;
      const message = e?.data?.error ?? e?.message ?? "request_failed";
      throw new ApiError(status, message);
    }
  }

  return {
    apiBase: base,

    async register(input: { email: string; password: string; name: string; locale?: string }) {
      const res = await call<{ token: string; user: any }>("/auth/register", { method: "POST", body: input });
      auth.setSession(res.token, res.user);
      return res;
    },
    async login(input: { email: string; password: string }) {
      const res = await call<{ token: string; user: any }>("/auth/login", { method: "POST", body: input });
      auth.setSession(res.token, res.user);
      return res;
    },
    async me() {
      return await call<{ user: any }>("/auth/me");
    },

    async listBusinesses() {
      return await call<{ businesses: OwnedBusiness[] }>("/me/businesses");
    },
    async createBusiness(input: { name: string; niche: string; timezone: string }) {
      return await call<{ business: OwnedBusiness }>("/me/businesses", { method: "POST", body: input });
    },
    async getBusiness(id: string) {
      return await call<{ business: OwnedBusiness; myRole: string }>(`/me/businesses/${id}`);
    },
    async updateBusiness(id: string, input: Partial<{ name: string; timezone: string; workingHours: WorkingHours; taxPercent: number }>) {
      return await call<{ business: OwnedBusiness }>(`/me/businesses/${id}`, { method: "PATCH", body: input });
    },

    async listServices(businessId: string) {
      return await call<{ services: OwnedService[] }>(`/me/businesses/${businessId}/services`);
    },
    async createService(
      businessId: string,
      input: { name: string; durationMin: number; priceCents: number; currency: string; photoUrl?: string }
    ) {
      return await call<{ service: OwnedService }>(`/me/businesses/${businessId}/services`, { method: "POST", body: input });
    },
    async updateService(businessId: string, serviceId: string, input: Partial<{ name: string; durationMin: number; priceCents: number; currency: string; photoUrl: string }>) {
      return await call<{ service: OwnedService }>(`/me/businesses/${businessId}/services/${serviceId}`, { method: "PATCH", body: input });
    },
    async deleteService(businessId: string, serviceId: string) {
      return await call(`/me/businesses/${businessId}/services/${serviceId}`, { method: "DELETE" });
    },

    async listStaff(businessId: string) {
      return await call<{ staff: OwnedStaff[] }>(`/me/businesses/${businessId}/staff`);
    },
    async createStaff(businessId: string, input: { name: string; serviceIds: string[]; colorHex?: string; photoUrl?: string; commissionPercent?: number }) {
      return await call<{ staff: OwnedStaff }>(`/me/businesses/${businessId}/staff`, { method: "POST", body: input });
    },
    async updateStaff(
      businessId: string,
      staffId: string,
      input: Partial<{ name: string; serviceIds: string[]; colorHex: string; photoUrl: string; workingHours: WorkingHours | null; commissionPercent: number }>
    ) {
      return await call<{ staff: OwnedStaff }>(`/me/businesses/${businessId}/staff/${staffId}`, { method: "PATCH", body: input });
    },
    async deleteStaff(businessId: string, staffId: string) {
      return await call(`/me/businesses/${businessId}/staff/${staffId}`, { method: "DELETE" });
    },

    async listAppointments(businessId: string) {
      return await call<{ appointments: OwnedAppointment[] }>(`/me/businesses/${businessId}/appointments`);
    },
    async listClients(businessId: string) {
      return await call<{ clients: any[] }>(`/me/businesses/${businessId}/clients`);
    },
    async getAnalytics(businessId: string) {
      return await call<AnalyticsResponse>(`/me/businesses/${businessId}/analytics`);
    },

    // ---- Подписка (дописано) ----
    async getSubscription(businessId: string) {
      return await call<{ subscription: OwnedSubscription | null }>(`/me/businesses/${businessId}/subscription`);
    },
    async startTrial(businessId: string, plan: SubscriptionPlanId) {
      return await call<{ subscription: OwnedSubscription }>(`/me/businesses/${businessId}/subscription/start-trial`, {
        method: "POST",
        body: { plan },
      });
    },
    async startCardBinding(businessId: string, returnUrl: string) {
      return await call<{ confirmationUrl: string | null; paymentId: string }>(
        `/me/businesses/${businessId}/subscription/start-card-binding`,
        { method: "POST", body: { returnUrl } }
      );
    },
    async cancelSubscription(businessId: string) {
      return await call<{ subscription: OwnedSubscription }>(`/me/businesses/${businessId}/subscription/cancel`, {
        method: "POST",
      });
    },
    async validatePromoCode(businessId: string, code: string) {
      return await call<{ valid: true; discountType: "percent" | "fixed"; discountValue: number }>(
        `/me/businesses/${businessId}/subscription/validate-promo`,
        { method: "POST", body: { code } }
      );
    },

    // ---- Telegram-бот (дописано) ----
    async getTelegramStatus(businessId: string) {
      return await call<{ connected: boolean; botUsername: string | null }>(`/me/businesses/${businessId}/telegram`);
    },
    async connectTelegramBot(businessId: string, botToken: string) {
      return await call<{ connected: boolean; botUsername?: string; webhookRegistered: boolean; webhookWarning?: string }>(
        `/me/businesses/${businessId}/telegram`,
        { method: "PATCH", body: { botToken } }
      );
    },
    async disconnectTelegramBot(businessId: string) {
      return await call<{ connected: boolean }>(`/me/businesses/${businessId}/telegram`, { method: "DELETE" });
    },
  };
}
