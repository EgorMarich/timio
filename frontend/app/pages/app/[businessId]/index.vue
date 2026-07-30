<script setup lang="ts">
import { ref, onMounted, computed, reactive } from "vue";
import {
  useTimioAuthApi,
  type OwnedBusiness,
  type OwnedService,
  type OwnedStaff,
  type OwnedAppointment,
  type AnalyticsResponse,
  type WorkingHours,
  type OwnedSubscription,
  type SubscriptionPlanId,
} from "../../../composables/useTimioAuthApi";
import { useAuthStore } from "../../../stores/auth";
import { downloadAnalyticsXlsx } from "../../../utils/xlsxReport";

definePageMeta({ middleware: "auth" });

const route = useRoute();
const router = useRouter();
const businessId = route.params.businessId as string;

const api = useTimioAuthApi();
const auth = useAuthStore();

const business = ref<OwnedBusiness | null>(null);
const services = ref<OwnedService[]>([]);
const staff = ref<OwnedStaff[]>([]);
const appointments = ref<OwnedAppointment[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");

type Tab = "overview" | "appointments" | "archive" | "services" | "staff" | "analytics" | "billing" | "settings";
const tab = ref<Tab>("overview");

async function loadAll() {
  status.value = "loading";
  try {
    const [b, s, st, ap] = await Promise.all([
      api.getBusiness(businessId),
      api.listServices(businessId),
      api.listStaff(businessId),
      api.listAppointments(businessId),
    ]);
    business.value = b.business;
    services.value = s.services;
    staff.value = st.staff;
    appointments.value = ap.appointments;
    status.value = "ready";
  } catch {
    status.value = "error";
  }
}

onMounted(loadAll);

const publicUrl = computed(() => {
  const webOrigin = typeof window !== "undefined" ? window.location.origin : "";
  return business.value ? `${webOrigin}/${business.value.slug}` : "";
});

const upcomingCount = computed(() => appointments.value.filter((a) => a.status === "booked").length);

// Только БУДУЩИЕ и не отменённые записи показываем на основной доске - прошедшие
// уходят в архив (см. archivedAppointments ниже).
const upcomingAppointments = computed(() =>
  appointments.value.filter((a) => new Date(a.startAt).getTime() >= Date.now() && a.status !== "cancelled")
);
const archivedAppointments = computed(() =>
  appointments.value
    .filter((a) => new Date(a.startAt).getTime() < Date.now() || a.status === "cancelled" || a.status === "completed" || a.status === "no_show")
    .sort((a, b) => b.startAt.localeCompare(a.startAt)) // новые сверху
);

const appointmentsByStaff = computed(() => {
  return staff.value.map((member) => ({
    staff: member,
    appointments: upcomingAppointments.value
      .filter((a) => a.staffId === member.id)
      .sort((a, b) => a.startAt.localeCompare(b.startAt)),
  }));
});

// ---- Детали клиента / мастера по клику ----
const selectedClientId = ref<string | null>(null);
const selectedStaffId = ref<string | null>(null);

const selectedClientAppointments = computed(() =>
  !selectedClientId.value
    ? []
    : appointments.value
        .filter((a) => a.clientId === selectedClientId.value)
        .sort((a, b) => b.startAt.localeCompare(a.startAt))
);
const selectedClientName = computed(() => selectedClientAppointments.value[0]?.clientName ?? "");
const selectedClientStats = computed(() => {
  const list = selectedClientAppointments.value;
  const completed = list.filter((a) => a.status === "completed" || a.status === "booked");
  return { visits: list.length, upcoming: list.filter((a) => new Date(a.startAt).getTime() >= Date.now()).length };
});

const selectedStaffMember = computed(() => staff.value.find((s) => s.id === selectedStaffId.value) ?? null);
// Уникальные клиенты этого мастера + сколько раз были у него
const selectedStaffClients = computed(() => {
  if (!selectedStaffId.value) return [];
  const byClient = new Map<string, { clientId: string; name: string; visits: number; lastVisit: string }>();
  for (const a of appointments.value) {
    if (a.staffId !== selectedStaffId.value || !a.clientId) continue;
    const entry = byClient.get(a.clientId) ?? { clientId: a.clientId, name: a.clientName ?? "—", visits: 0, lastVisit: a.startAt };
    entry.visits += 1;
    if (a.startAt > entry.lastVisit) entry.lastVisit = a.startAt;
    byClient.set(a.clientId, entry);
  }
  return [...byClient.values()].sort((a, b) => b.lastVisit.localeCompare(a.lastVisit));
});

function openClientDetail(clientId?: string) {
  if (!clientId) return;
  selectedClientId.value = clientId;
}
function openStaffDetail(staffId: string) {
  selectedStaffId.value = staffId;
}
function openClientFromStaffModal(clientId: string) {
  selectedStaffId.value = null;
  selectedClientId.value = clientId;
}

function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}
function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}
function formatMoney(cents: number, currency = "") {
  return `${(cents / 100).toFixed(0)} ${currency}`.trim();
}

// ---- Услуги ----
const newServiceName = ref("");
const newServiceDuration = ref(30);
const newServicePrice = ref(0);
const newServiceCurrency = ref("RUB");
const newServicePhoto = ref<string | null>(null);
const addingService = ref(false);

async function addService() {
  if (!newServiceName.value.trim()) return;
  addingService.value = true;
  try {
    await api.createService(businessId, {
      name: newServiceName.value,
      durationMin: newServiceDuration.value,
      priceCents: Math.round(newServicePrice.value * 100),
      currency: newServiceCurrency.value,
      photoUrl: newServicePhoto.value ?? undefined,
    });
    newServiceName.value = "";
    newServiceDuration.value = 30;
    newServicePrice.value = 0;
    newServicePhoto.value = null;
    const s = await api.listServices(businessId);
    services.value = s.services;
  } finally {
    addingService.value = false;
  }
}
async function removeService(id: string) {
  await api.deleteService(businessId, id);
  services.value = services.value.filter((s) => s.id !== id);
}

// ---- Сотрудники ----
const newStaffName = ref("");
const newStaffServiceIds = ref<string[]>([]);
const newStaffPhoto = ref<string | null>(null);
const addingStaff = ref(false);
const expandedStaffId = ref<string | null>(null);

// Черновики редактирования расписания/комиссии по каждому сотруднику
const staffDrafts = reactive<Record<string, { workingHours: WorkingHours; inherited: boolean; commissionPercent: number; saving: boolean }>>({});

function ensureDraft(member: OwnedStaff) {
  if (!staffDrafts[member.id]) {
    staffDrafts[member.id] = {
      workingHours: member.workingHours ?? emptyWeek(),
      inherited: !member.workingHours,
      commissionPercent: member.commissionPercentBp / 100,
      saving: false,
    };
  }
  return staffDrafts[member.id];
}
function emptyWeek(): WorkingHours {
  return { 1: { start: 600, end: 1200 }, 2: { start: 600, end: 1200 }, 3: { start: 600, end: 1200 }, 4: { start: 600, end: 1200 }, 5: { start: 600, end: 1200 }, 6: null, 0: null };
}

function toggleExpand(member: OwnedStaff) {
  expandedStaffId.value = expandedStaffId.value === member.id ? null : member.id;
  ensureDraft(member);
}

async function addStaff() {
  if (!newStaffName.value.trim() || newStaffServiceIds.value.length === 0) return;
  addingStaff.value = true;
  try {
    await api.createStaff(businessId, {
      name: newStaffName.value,
      serviceIds: newStaffServiceIds.value,
      photoUrl: newStaffPhoto.value ?? undefined,
    });
    newStaffName.value = "";
    newStaffServiceIds.value = [];
    newStaffPhoto.value = null;
    const st = await api.listStaff(businessId);
    staff.value = st.staff;
  } finally {
    addingStaff.value = false;
  }
}
async function removeStaff(id: string) {
  await api.deleteStaff(businessId, id);
  staff.value = staff.value.filter((s) => s.id !== id);
}
function toggleServiceForStaff(id: string) {
  const idx = newStaffServiceIds.value.indexOf(id);
  if (idx === -1) newStaffServiceIds.value.push(id);
  else newStaffServiceIds.value.splice(idx, 1);
}
async function saveStaffPhoto(member: OwnedStaff, photo: string | null) {
  await api.updateStaff(businessId, member.id, { photoUrl: photo ?? "" });
  const st = await api.listStaff(businessId);
  staff.value = st.staff;
}
async function saveStaffSchedule(member: OwnedStaff) {
  const draft = ensureDraft(member);
  draft.saving = true;
  try {
    await api.updateStaff(businessId, member.id, {
      workingHours: draft.inherited ? null : draft.workingHours,
      commissionPercent: draft.commissionPercent,
    });
    const st = await api.listStaff(businessId);
    staff.value = st.staff;
  } finally {
    draft.saving = false;
  }
}

// ---- Настройки бизнеса ----
const businessDraft = reactive({ timezone: "", taxPercent: 0, workingHours: emptyWeek(), savingSettings: false });
function loadBusinessDraft() {
  if (!business.value) return;
  businessDraft.timezone = business.value.timezone;
  businessDraft.taxPercent = business.value.taxPercentBp / 100;
  businessDraft.workingHours = business.value.workingHours;
}
async function saveBusinessSettings() {
  businessDraft.savingSettings = true;
  try {
    await api.updateBusiness(businessId, {
      timezone: businessDraft.timezone,
      taxPercent: businessDraft.taxPercent,
      workingHours: businessDraft.workingHours,
    });
    const b = await api.getBusiness(businessId);
    business.value = b.business;
  } finally {
    businessDraft.savingSettings = false;
  }
}

// ---- Аналитика ----
const analytics = ref<AnalyticsResponse | null>(null);
const analyticsStatus = ref<"idle" | "loading" | "ready" | "error">("idle");

async function loadAnalytics() {
  analyticsStatus.value = "loading";
  try {
    analytics.value = await api.getAnalytics(businessId);
    analyticsStatus.value = "ready";
  } catch {
    analyticsStatus.value = "error";
  }
}

// ---- Подписка ----
const subscription = ref<OwnedSubscription | null>(null);
const billingStatus = ref<"idle" | "loading" | "ready" | "error">("idle");
const selectedPlan = ref<SubscriptionPlanId>("basic");
const startingTrial = ref(false);
const bindingCard = ref(false);
const cancelling = ref(false);
const promoCodeInput = ref("");
const promoCheckStatus = ref<"idle" | "checking" | "valid" | "invalid">("idle");
const promoDiscountLabel = ref("");
const billingError = ref("");

async function loadBilling() {
  billingStatus.value = "loading";
  try {
    const res = await api.getSubscription(businessId);
    subscription.value = res.subscription;
    billingStatus.value = "ready";
  } catch {
    billingStatus.value = "error";
  }
}

async function handleStartTrial() {
  billingError.value = "";
  startingTrial.value = true;
  try {
    const res = await api.startTrial(businessId, selectedPlan.value);
    subscription.value = res.subscription;
  } catch (e: any) {
    billingError.value = e?.message ?? "Не удалось запустить пробный период";
  } finally {
    startingTrial.value = false;
  }
}

async function handleStartCardBinding() {
  billingError.value = "";
  bindingCard.value = true;
  try {
    // После подтверждения оплаты ЮKassa вернёт пользователя на ЭТУ ЖЕ страницу -
    // при возврате достаточно просто заново загрузить статус подписки.
    const returnUrl = window.location.href;
    const res = await api.startCardBinding(businessId, returnUrl);
    if (res.confirmationUrl) {
      window.location.href = res.confirmationUrl; // редирект на страницу оплаты ЮKassa
    } else {
      billingError.value = "ЮKassa не вернула ссылку на подтверждение оплаты";
    }
  } catch (e: any) {
    billingError.value = e?.message ?? "Не удалось начать привязку карты";
  } finally {
    bindingCard.value = false;
  }
}

async function handleCancelSubscription() {
  if (!confirm("Отменить подписку? Доступ сохранится до конца оплаченного периода.")) return;
  cancelling.value = true;
  try {
    const res = await api.cancelSubscription(businessId);
    subscription.value = res.subscription;
  } finally {
    cancelling.value = false;
  }
}

async function checkPromoCode() {
  if (!promoCodeInput.value.trim()) return;
  promoCheckStatus.value = "checking";
  try {
    const res = await api.validatePromoCode(businessId, promoCodeInput.value.trim());
    promoCheckStatus.value = "valid";
    promoDiscountLabel.value =
      res.discountType === "percent" ? `−${res.discountValue}% на первый месяц` : `−${(res.discountValue / 100).toFixed(0)} ₽ на первый месяц`;
  } catch {
    promoCheckStatus.value = "invalid";
    promoDiscountLabel.value = "";
  }
}

const subscriptionStatusLabel: Record<string, string> = {
  trial: "Пробный период",
  active: "Активна",
  expired: "Истекла",
  cancelled: "Отменена",
};
const subscriptionPlanLabel: Record<string, string> = {
  basic: "Базовый",
  business: "Бизнес",
};

function daysLeft(iso: string) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
}
// ---- Telegram-бот (реальная отправка уведомлений) ----
const telegramConnected = ref(false);
const telegramBotUsername = ref<string | null>(null);
const telegramTokenInput = ref("");
const telegramConnecting = ref(false);
const telegramError = ref("");
const telegramWarning = ref("");

async function loadTelegramStatus() {
  try {
    const res = await api.getTelegramStatus(businessId);
    telegramConnected.value = res.connected;
    telegramBotUsername.value = res.botUsername;
  } catch {
    /* не критично для остального экрана настроек */
  }
}

async function connectTelegram() {
  if (!telegramTokenInput.value.trim()) return;
  telegramError.value = "";
  telegramWarning.value = "";
  telegramConnecting.value = true;
  try {
    const res = await api.connectTelegramBot(businessId, telegramTokenInput.value.trim());
    telegramConnected.value = res.connected;
    telegramBotUsername.value = res.botUsername ?? null;
    telegramTokenInput.value = "";
    if (!res.webhookRegistered && res.webhookWarning) telegramWarning.value = res.webhookWarning;
  } catch (e: any) {
    telegramError.value = e?.message ?? "Не удалось подключить бота. Проверьте токен.";
  } finally {
    telegramConnecting.value = false;
  }
}

async function disconnectTelegram() {
  await api.disconnectTelegramBot(businessId);
  telegramConnected.value = false;
  telegramBotUsername.value = null;
}
function openTab(t: Tab) {
  tab.value = t;
  if (t === "analytics" && analyticsStatus.value === "idle") loadAnalytics();
  if (t === "settings") {
    loadBusinessDraft();
    loadTelegramStatus();
  }
  if (t === "billing" && billingStatus.value === "idle") loadBilling();
}

function exportXlsx() {
  if (!analytics.value || !business.value) return;
  downloadAnalyticsXlsx(business.value.name, analytics.value);
}

const revenueByDayChart = computed(
  () => analytics.value?.byDay.map((d) => ({ label: d.date.slice(5), value: d.revenueCents / 100 })) ?? []
);
const revenueByServiceChart = computed(
  () => analytics.value?.byService.map((s) => ({ label: s.name, value: s.revenueCents / 100 })) ?? []
);
const revenueByStaffChart = computed(
  () => analytics.value?.byStaff.map((s) => ({ label: s.name, value: s.revenueCents / 100 })) ?? []
);

function logout() {
  auth.logout();
  router.push("/login");
}
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="brand" style="padding: 6px 8px 20px">
        <span class="brand-mark">T</span>
        <span class="brand-name">Timio</span>
      </div>
      <a class="sidebar-nav-item" :class="{ active: tab === 'overview' }" @click="openTab('overview')"><span class="nav-icon">◱</span> Обзор</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'appointments' }" @click="openTab('appointments')"><span class="nav-icon">▤</span> Записи</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'archive' }" @click="openTab('archive')"><span class="nav-icon">▦</span> Архив</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'services' }" @click="openTab('services')"><span class="nav-icon">◇</span> Услуги</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'staff' }" @click="openTab('staff')"><span class="nav-icon">◍</span> Сотрудники</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'analytics' }" @click="openTab('analytics')"><span class="nav-icon">▲</span> Аналитика</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'billing' }" @click="openTab('billing')"><span class="nav-icon">◈</span> Подписка</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'settings' }" @click="openTab('settings')"><span class="nav-icon">⚙</span> Настройки</a>
      <div style="flex: 1" />
      <a class="sidebar-nav-item" @click="logout"><span class="nav-icon">←</span> Выйти</a>
    </aside>

    <main class="app-main">
      <div v-if="status === 'loading'" class="text-dim">Загрузка…</div>

      <div v-else-if="status === 'error'" class="panel">
        <div class="error-banner" style="margin-bottom: 0">
          Не удалось загрузить данные компании. Проверьте, что backend API запущен, и обновите страницу.
        </div>
      </div>

      <template v-else-if="business">
        <div class="topbar">
          <div>
            <p class="page-title" style="margin-bottom: 2px">{{ business.name }}</p>
            <a :href="publicUrl" target="_blank" class="text-dim" style="font-size: 13px">{{ publicUrl }} ↗</a>
          </div>
          <ThemeToggle />
        </div>

        <!-- Обзор -->
        <div v-if="tab === 'overview'">
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 28px">
            <div class="stat-card">
              <div class="stat-label">Предстоящие записи</div>
              <div class="stat-value">{{ upcomingCount }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Услуги</div>
              <div class="stat-value">{{ services.length }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">Сотрудники</div>
              <div class="stat-value">{{ staff.length }}</div>
            </div>
          </div>

          <p class="page-subtitle" style="margin-bottom: 12px; font-weight: 700; color: var(--text)">Ближайшие записи</p>
          <div v-if="appointments.length === 0" class="empty-state panel">
            <div class="title">Пока нет записей</div>
            <p>Поделитесь ссылкой на вашу страницу записи, чтобы получить первого клиента.</p>
          </div>
          <div v-for="a in appointments.slice(0, 5)" :key="a.id" class="data-row">
            <div style="display: flex; align-items: center; gap: 12px">
              <span class="avatar-circle" style="background: var(--accent)">{{ initials(a.clientName || "?") }}</span>
              <div>
                <div
                  style="font-weight: 600; font-size: 14px; cursor: pointer; text-decoration: underline dotted; display: inline-block"
                  @click="openClientDetail(a.clientId)"
                >
                  {{ a.clientName }}
                </div>
                <div class="text-dim text-xs">{{ a.serviceName }} · {{ a.staffName }} · {{ formatDateTime(a.startAt) }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Записи: колоночное расписание по сотрудникам (только предстоящие) -->
        <div v-else-if="tab === 'appointments'">
          <div v-if="staff.length === 0" class="empty-state panel">
            <div class="title">Сначала добавьте сотрудников</div>
            <p>Расписание группируется по сотрудникам — добавьте хотя бы одного во вкладке «Сотрудники».</p>
          </div>
          <div v-else class="schedule-board">
            <div v-for="col in appointmentsByStaff" :key="col.staff.id" class="schedule-column">
              <div class="schedule-column-head" style="cursor: pointer" @click="openStaffDetail(col.staff.id)">
                <img v-if="col.staff.photoUrl" :src="col.staff.photoUrl" class="option-avatar" alt="" />
                <span v-else class="avatar-circle" :style="{ background: col.staff.colorHex }">{{ initials(col.staff.name) }}</span>
                <span class="schedule-column-name">{{ col.staff.name }}</span>
              </div>
              <div v-if="col.appointments.length === 0" class="schedule-empty">Нет записей</div>
              <div v-for="a in col.appointments" :key="a.id" class="appointment-card">
                <span class="appointment-time mono">{{ formatTime(a.startAt) }}</span>
                <div class="appointment-client" style="cursor: pointer; text-decoration: underline dotted" @click="openClientDetail(a.clientId)">
                  {{ a.clientName }}
                </div>
                <div class="appointment-service text-dim text-xs">{{ a.serviceName }}</div>
                <span class="badge mt-4" :class="`status-${a.status}`" style="margin-top: 8px">{{ a.status }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Архив: прошедшие/отменённые записи -->
        <div v-else-if="tab === 'archive'">
          <div v-if="archivedAppointments.length === 0" class="empty-state panel">
            <div class="title">Архив пуст</div>
            <p>Здесь появятся записи после того, как визит состоится или будет отменён.</p>
          </div>
          <div v-for="a in archivedAppointments" :key="a.id" class="data-row">
            <div style="display: flex; align-items: center; gap: 12px">
              <span class="avatar-circle" style="background: var(--accent)">{{ initials(a.clientName || "?") }}</span>
              <div>
                <div
                  style="font-weight: 600; font-size: 14px; cursor: pointer; text-decoration: underline dotted; display: inline-block"
                  @click="openClientDetail(a.clientId)"
                >
                  {{ a.clientName }}
                </div>
                <div class="text-dim text-xs">{{ a.serviceName }} · {{ a.staffName }} · {{ formatDateTime(a.startAt) }}</div>
              </div>
            </div>
            <span class="badge" :class="`status-${a.status}`">{{ a.status }}</span>
          </div>
        </div>

        <!-- Услуги -->
        <div v-else-if="tab === 'services'">
          <div class="panel mt-4" style="margin-bottom: 20px">
            <p class="field-label" style="margin-bottom: 12px">Новая услуга</p>
            <div style="display: flex; gap: 16px; align-items: flex-start">
              <PhotoUpload v-model="newServicePhoto" shape="square" />
              <div style="flex: 1">
                <div class="field">
                  <input v-model="newServiceName" type="text" placeholder="Название услуги" />
                </div>
                <div style="display: flex; gap: 10px">
                  <div class="field" style="flex: 1">
                    <input v-model.number="newServiceDuration" type="number" placeholder="Минут" />
                  </div>
                  <div class="field" style="flex: 1">
                    <input v-model.number="newServicePrice" type="number" placeholder="Цена" />
                  </div>
                  <div class="field" style="width: 90px">
                    <select v-model="newServiceCurrency">
                      <option>RUB</option><option>USD</option><option>EUR</option><option>KZT</option><option>AMD</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
            <button class="btn-secondary" :disabled="addingService" @click="addService">+ Добавить услугу</button>
          </div>

          <div v-if="services.length === 0" class="empty-state panel">
            <div class="title">Пока нет услуг</div>
            <p>Добавьте услугу выше, чтобы клиенты могли на неё записаться.</p>
          </div>
          <div v-for="s in services" :key="s.id" class="data-row">
            <div style="display: flex; align-items: center; gap: 12px">
              <img v-if="s.photoUrl" :src="s.photoUrl" class="option-photo" alt="" />
              <div>
                <div style="font-weight: 600; font-size: 14px">{{ s.name.ru || s.name.en }}</div>
                <div class="text-dim text-xs">{{ s.durationMin }} мин</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px">
              <span class="mono text-dim" style="font-size: 13px">{{ formatMoney(s.priceCents, s.currency) }}</span>
              <button class="btn-danger-text" @click="removeService(s.id)">Удалить</button>
            </div>
          </div>
        </div>

        <!-- Сотрудники -->
        <div v-else-if="tab === 'staff'">
          <div class="panel mt-4" style="margin-bottom: 20px">
            <p class="field-label" style="margin-bottom: 12px">Новый сотрудник</p>
            <div style="display: flex; gap: 16px; align-items: flex-start; margin-bottom: 14px">
              <PhotoUpload v-model="newStaffPhoto" shape="circle" />
              <div style="flex: 1">
                <div class="field">
                  <input v-model="newStaffName" type="text" placeholder="Имя сотрудника" />
                </div>
                <p class="field-label">Услуги, которые он оказывает</p>
                <div style="display: flex; flex-wrap: wrap; gap: 8px">
                  <span
                    v-for="s in services"
                    :key="s.id"
                    class="badge"
                    :style="newStaffServiceIds.includes(s.id) ? 'background:var(--accent-dim);color:var(--accent);cursor:pointer' : 'cursor:pointer'"
                    @click="toggleServiceForStaff(s.id)"
                  >
                    {{ s.name.ru || s.name.en }}
                  </span>
                </div>
              </div>
            </div>
            <button class="btn-secondary" :disabled="addingStaff" @click="addStaff">+ Добавить сотрудника</button>
          </div>

          <div v-if="staff.length === 0" class="empty-state panel">
            <div class="title">Пока нет сотрудников</div>
          </div>
          <div v-for="s in staff" :key="s.id" class="panel mt-4" style="padding: 0; margin-bottom: 10px; overflow: hidden">
            <div class="data-row" style="border: none; margin-bottom: 0; cursor: pointer" @click="toggleExpand(s)">
              <div style="display: flex; align-items: center; gap: 10px">
                <img v-if="s.photoUrl" :src="s.photoUrl" class="option-avatar" alt="" />
                <span v-else class="avatar-circle" :style="{ background: s.colorHex }">{{ initials(s.name) }}</span>
                <span style="font-weight: 600; font-size: 14px">{{ s.name }}</span>
                <span class="text-dim text-xs" v-if="s.commissionPercentBp">{{ s.commissionPercentBp / 100 }}% комиссия</span>
              </div>
              <div style="display: flex; align-items: center; gap: 14px">
                <button class="btn-link" @click.stop="openStaffDetail(s.id)">Клиенты</button>
                <span class="text-dim text-xs">{{ expandedStaffId === s.id ? "Свернуть ▲" : "Расписание и фото ▼" }}</span>
                <button class="btn-danger-text" @click.stop="removeStaff(s.id)">Удалить</button>
              </div>
            </div>

            <div v-if="expandedStaffId === s.id" style="padding: 16px; border-top: 1px solid var(--border)">
              <div style="display: flex; gap: 20px; align-items: flex-start; margin-bottom: 18px">
                <PhotoUpload :model-value="s.photoUrl" shape="circle" @update:model-value="(v) => saveStaffPhoto(s, v)" />
                <div style="flex: 1">
                  <label class="field-label">Комиссия сотрудника (% с каждой услуги)</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    v-model.number="staffDrafts[s.id].commissionPercent"
                    style="max-width: 140px"
                  />
                </div>
              </div>

              <p class="field-label" style="margin-bottom: 10px">Окно приёма сотрудника</p>
              <WorkingHoursEditor
                v-model="staffDrafts[s.id].workingHours"
                allow-inherit
                v-model:inherited="staffDrafts[s.id].inherited"
              />

              <button class="btn-primary mt-4" :disabled="staffDrafts[s.id].saving" @click="saveStaffSchedule(s)">
                {{ staffDrafts[s.id].saving ? "…" : "Сохранить" }}
              </button>
            </div>
          </div>
        </div>

        <!-- Аналитика -->
        <div v-else-if="tab === 'analytics'">
          <div v-if="analyticsStatus === 'loading'" class="text-dim">Считаем…</div>

          <div v-else-if="analyticsStatus === 'error'" class="error-banner">Не удалось загрузить аналитику.</div>

          <template v-else-if="analytics">
            <div class="flex-between mt-4" style="margin-bottom: 20px">
              <p class="page-subtitle" style="margin: 0; font-weight: 700; color: var(--text)">Сводка</p>
              <button class="btn-secondary" @click="exportXlsx">⭳ Скачать .xlsx отчёт</button>
            </div>

            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 20px">
              <div class="stat-card">
                <div class="stat-label">Выручка</div>
                <div class="stat-value">{{ formatMoney(analytics.summary.totalRevenueCents) }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Налог ({{ analytics.summary.taxPercent }}%)</div>
                <div class="stat-value">−{{ formatMoney(analytics.summary.taxCents) }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Комиссии сотрудников</div>
                <div class="stat-value">−{{ formatMoney(analytics.summary.totalCommissionCents) }}</div>
              </div>
              <div class="stat-card" style="border-color: var(--accent)">
                <div class="stat-label">Чистая прибыль</div>
                <div class="stat-value" style="color: var(--accent)">{{ formatMoney(analytics.summary.netProfitCents) }}</div>
              </div>
            </div>

            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 28px">
              <div class="stat-card">
                <div class="stat-label">Записей</div>
                <div class="stat-value">{{ analytics.summary.totalAppointments }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Клиентов</div>
                <div class="stat-value">{{ analytics.summary.totalClients }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Средний чек</div>
                <div class="stat-value">{{ formatMoney(analytics.summary.avgCheckCents) }}</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Неявки / Отмены</div>
                <div class="stat-value">{{ analytics.summary.noShowCount }} / {{ analytics.summary.cancelledCount }}</div>
              </div>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px">
              <div class="panel">
                <p class="field-label" style="margin-bottom: 14px">Выручка по дням</p>
                <BarChart :data="revenueByDayChart" :format-value="(v) => v.toFixed(0)" />
              </div>
              <div class="panel">
                <p class="field-label" style="margin-bottom: 14px">Выручка по услугам</p>
                <BarChart :data="revenueByServiceChart" :format-value="(v) => v.toFixed(0)" color="var(--success)" />
              </div>
              <div class="panel" style="grid-column: 1 / -1">
                <p class="field-label" style="margin-bottom: 14px">Выручка по сотрудникам</p>
                <BarChart :data="revenueByStaffChart" :format-value="(v) => v.toFixed(0)" />
              </div>
            </div>
          </template>
        </div>

        <!-- Подписка -->
        <div v-else-if="tab === 'billing'">
          <div v-if="billingStatus === 'loading'" class="text-dim">Загрузка…</div>
          <div v-else-if="billingStatus === 'error'" class="error-banner">Не удалось загрузить подписку.</div>

          <template v-else>
            <div v-if="billingError" class="error-banner">{{ billingError }}</div>

            <!-- Подписки ещё нет - выбор тарифа -->
            <div v-if="!subscription" class="panel" style="max-width: 480px">
              <p class="field-label" style="margin-bottom: 12px">Выберите тариф</p>
              <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px">
                <label class="option" style="cursor: pointer">
                  <input type="radio" value="basic" v-model="selectedPlan" style="margin-right: 10px; width: auto" />
                  <div>
                    <div style="font-weight: 700">Базовый</div>
                    <div class="text-dim text-xs">До 5 сотрудников · 1490 ₽/мес</div>
                  </div>
                </label>
                <label class="option" style="cursor: pointer">
                  <input type="radio" value="business" v-model="selectedPlan" style="margin-right: 10px; width: auto" />
                  <div>
                    <div style="font-weight: 700">Бизнес</div>
                    <div class="text-dim text-xs">2490 ₽/мес + 390 ₽ за каждого сотрудника сверх 5</div>
                  </div>
                </label>
              </div>
              <p class="helper-text" style="margin-bottom: 16px">
                14 дней бесплатно. Карта привязывается, но списание произойдёт только после окончания пробного периода.
              </p>
              <button class="btn-primary" :disabled="startingTrial" @click="handleStartTrial">
                {{ startingTrial ? "…" : "Начать пробный период" }}
              </button>
            </div>

            <!-- Подписка есть -->
            <div v-else style="max-width: 480px">
              <div class="panel" style="margin-bottom: 20px">
                <div class="flex-between" style="margin-bottom: 14px">
                  <div>
                    <div style="font-weight: 900; font-size: 18px">{{ subscriptionPlanLabel[subscription.plan] }}</div>
                    <div class="text-dim text-xs">Тариф</div>
                  </div>
                  <span
                    class="badge"
                    :style="
                      subscription.status === 'active'
                        ? 'background:var(--success-dim);color:var(--success)'
                        : subscription.status === 'trial'
                        ? 'background:var(--accent-dim);color:var(--accent)'
                        : ''
                    "
                  >
                    {{ subscriptionStatusLabel[subscription.status] }}
                  </span>
                </div>

                <div v-if="subscription.status === 'trial'" class="text-dim" style="font-size: 13px; margin-bottom: 14px">
                  Пробный период закончится через <b style="color: var(--text)">{{ daysLeft(subscription.trialEndsAt) }} дн.</b>
                  <template v-if="!subscription.yookassaPaymentMethodId"> — карта ещё не привязана.</template>
                  <template v-else> — карта привязана, автосписание произойдёт автоматически.</template>
                </div>
                <div v-else-if="subscription.status === 'active' && subscription.currentPeriodEndsAt" class="text-dim" style="font-size: 13px; margin-bottom: 14px">
                  Следующее списание: {{ new Date(subscription.currentPeriodEndsAt).toLocaleDateString("ru-RU") }}
                </div>

                <button
                  v-if="subscription.status === 'trial' && !subscription.yookassaPaymentMethodId"
                  class="btn-primary"
                  :disabled="bindingCard"
                  @click="handleStartCardBinding"
                >
                  {{ bindingCard ? "…" : "Привязать карту" }}
                </button>
                <button
                  v-if="subscription.status === 'trial' || subscription.status === 'active'"
                  class="btn-secondary mt-4"
                  style="width: 100%"
                  :disabled="cancelling"
                  @click="handleCancelSubscription"
                >
                  {{ cancelling ? "…" : "Отменить подписку" }}
                </button>
              </div>

              <!-- Промокод: применяется к первому месяцу оплаты -->
              <div v-if="subscription.status === 'trial'" class="panel">
                <p class="field-label" style="margin-bottom: 10px">Промокод на первый месяц</p>
                <div style="display: flex; gap: 8px">
                  <input v-model="promoCodeInput" type="text" placeholder="WELCOME20" style="flex: 1" />
                  <button class="btn-secondary" @click="checkPromoCode">Проверить</button>
                </div>
                <p v-if="promoCheckStatus === 'valid'" class="text-xs" style="color: var(--success); margin-top: 8px">
                  ✓ {{ promoDiscountLabel }}
                </p>
                <p v-else-if="promoCheckStatus === 'invalid'" class="text-xs" style="color: var(--accent); margin-top: 8px">
                  Промокод не найден или недействителен
                </p>
              </div>
            </div>
          </template>
        </div>

        <!-- Настройки -->
        <div v-else-if="tab === 'settings'">
          <div class="panel" style="max-width: 480px; margin-bottom: 20px">
            <p class="field-label" style="margin-bottom: 6px">Уведомления клиентам · Telegram</p>
            <p class="helper-text" style="margin-bottom: 14px">
              Создайте бота через
              <a href="https://t.me/BotFather" target="_blank" style="color: var(--accent)">@BotFather</a>
              (бесплатно, без модерации) и вставьте токен ниже — клиенты начнут получать напоминания в Telegram
              на своём языке.
            </p>

            <div v-if="telegramError" class="error-banner">{{ telegramError }}</div>
            <div v-if="telegramWarning" class="helper-text" style="color: var(--accent); margin-bottom: 12px">⚠ {{ telegramWarning }}</div>

            <div v-if="telegramConnected" class="data-row">
              <div>
                <div style="font-weight: 700">@{{ telegramBotUsername }}</div>
                <div class="text-dim text-xs">Подключён</div>
              </div>
              <button class="btn-danger-text" @click="disconnectTelegram">Отключить</button>
            </div>
            <div v-else style="display: flex; gap: 8px">
              <input v-model="telegramTokenInput" type="text" placeholder="123456:ABC-DEF... (токен от BotFather)" style="flex: 1" />
              <button class="btn-secondary" :disabled="telegramConnecting" @click="connectTelegram">
                {{ telegramConnecting ? "…" : "Подключить" }}
              </button>
            </div>
          </div>

          <div class="panel" style="max-width: 480px; margin-bottom: 20px">
            <p class="field-label" style="margin-bottom: 12px">Основные</p>
            <div class="field">
              <label class="field-label">Часовой пояс</label>
              <input v-model="businessDraft.timezone" type="text" />
            </div>
            <div class="field">
              <label class="field-label">Налог на выручку (%)</label>
              <input v-model.number="businessDraft.taxPercent" type="number" min="0" max="100" step="0.5" style="max-width: 140px" />
              <p class="helper-text">Используется в аналитике для расчёта чистой прибыли.</p>
            </div>
          </div>

          <div class="panel" style="max-width: 480px; margin-bottom: 20px">
            <p class="field-label" style="margin-bottom: 12px">Расписание по умолчанию</p>
            <p class="helper-text" style="margin-bottom: 12px">
              Используется для сотрудников без собственного индивидуального расписания.
            </p>
            <WorkingHoursEditor v-model="businessDraft.workingHours" />
          </div>

          <button class="btn-primary" style="max-width: 200px" :disabled="businessDraft.savingSettings" @click="saveBusinessSettings">
            {{ businessDraft.savingSettings ? "…" : "Сохранить настройки" }}
          </button>
        </div>
      </template>
    </main>

    <!-- История визитов клиента -->
    <Modal v-if="selectedClientId" :title="selectedClientName" @close="selectedClientId = null">
      <div class="flex-between mt-4" style="margin-bottom: 16px">
        <span class="text-dim text-xs">Визитов: {{ selectedClientStats.visits }}</span>
        <span class="text-dim text-xs">Предстоящих: {{ selectedClientStats.upcoming }}</span>
      </div>
      <div v-for="a in selectedClientAppointments" :key="a.id" class="data-row">
        <div>
          <div style="font-weight: 600; font-size: 14px">{{ a.serviceName }}</div>
          <div class="text-dim text-xs">{{ a.staffName }} · {{ formatDateTime(a.startAt) }}</div>
        </div>
        <span class="badge" :class="`status-${a.status}`">{{ a.status }}</span>
      </div>
    </Modal>

    <!-- Клиенты конкретного мастера -->
    <Modal v-if="selectedStaffId" :title="`Клиенты: ${selectedStaffMember?.name ?? ''}`" @close="selectedStaffId = null">
      <div v-if="selectedStaffClients.length === 0" class="empty-state">
        <div class="title">Пока нет клиентов</div>
      </div>
      <div
        v-for="c in selectedStaffClients"
        :key="c.clientId"
        class="data-row"
        style="cursor: pointer"
        @click="openClientFromStaffModal(c.clientId)"
      >
        <div>
          <div style="font-weight: 600; font-size: 14px">{{ c.name }}</div>
          <div class="text-dim text-xs">Последний визит: {{ formatDateTime(c.lastVisit) }}</div>
        </div>
        <span class="badge">{{ c.visits }} визит{{ c.visits === 1 ? "" : c.visits < 5 ? "а" : "ов" }}</span>
      </div>
    </Modal>
  </div>
</template>
