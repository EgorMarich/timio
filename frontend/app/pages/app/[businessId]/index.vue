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

type Tab = "overview" | "appointments" | "archive" | "services" | "staff" | "analytics" | "billing" | "templates" | "team" | "campaigns" | "settings";
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

// ---- Смена статуса записи ----
const statusOptions = ["booked", "confirmed", "completed", "cancelled", "no_show"] as const;

async function changeAppointmentStatus(apptId: string, newStatus: string) {
  await api.updateAppointmentStatus(businessId, apptId, newStatus);
  // Обновляем локально — не перезапрашиваем весь список
  const idx = appointments.value.findIndex((a) => a.id === apptId);
  if (idx !== -1) appointments.value[idx] = { ...appointments.value[idx], status: newStatus };
}

// ---- Шаблоны уведомлений ----
import type { OwnedTemplate } from "../../../composables/useTimioAuthApi";

const templates = ref<OwnedTemplate[]>([]);
const templatesStatus = ref<"idle" | "loading" | "ready" | "error">("idle");
// Черновики переводов: { [templateType]: { [locale]: text } }
const templateDrafts = reactive<Record<string, Record<string, string>>>({});
const templateSaving = reactive<Record<string, boolean>>({});

const LOCALES = ["ru", "en", "es", "it", "fr", "kk", "hy"] as const;

async function loadTemplates() {
  templatesStatus.value = "loading";
  try {
    const res = await api.listTemplates(businessId);
    templates.value = res.templates;
    // Инициализируем черновики из текущих переводов
    for (const t of res.templates) {
      templateDrafts[t.type] = { ...t.translations };
    }
    templatesStatus.value = "ready";
  } catch {
    templatesStatus.value = "error";
  }
}

async function saveTemplate(type: string) {
  templateSaving[type] = true;
  try {
    const res = await api.updateTemplate(businessId, type, templateDrafts[type]);
    const idx = templates.value.findIndex((t) => t.type === type);
    if (idx !== -1) templates.value[idx] = res.template;
  } finally {
    templateSaving[type] = false;
  }
}

// ---- Команда бизнеса ----
import type { OwnedMember } from "../../../composables/useTimioAuthApi";

const members = ref<OwnedMember[]>([]);
const membersStatus = ref<"idle" | "loading" | "ready" | "error">("idle");
const newMemberEmail = ref("");
const newMemberRole = ref<"administrator" | "manager" | "employee">("employee");
const addingMember = ref(false);
const memberError = ref("");

async function loadMembers() {
  membersStatus.value = "loading";
  try {
    const res = await api.listMembers(businessId);
    members.value = res.members;
    membersStatus.value = "ready";
  } catch {
    membersStatus.value = "error";
  }
}

async function addMember() {
  if (!newMemberEmail.value.trim()) return;
  memberError.value = "";
  addingMember.value = true;
  try {
    const res = await api.addMember(businessId, newMemberEmail.value.trim(), newMemberRole.value);
    members.value.push(res.member);
    newMemberEmail.value = "";
  } catch (e: any) {
    memberError.value = e?.message ?? "Не удалось добавить участника";
  } finally {
    addingMember.value = false;
  }
}

async function removeMember(memberId: string) {
  await api.removeMember(businessId, memberId);
  members.value = members.value.filter((m) => m.id !== memberId);
}

// ---- CRM: полная карточка клиента ----
import type { OwnedClientCard } from "../../../composables/useTimioAuthApi";

const clientCard = ref<OwnedClientCard | null>(null);
const clientCardLoading = ref(false);
// Черновик тегов и заметок для редактирования
const clientCrmDraft = reactive<{ tags: string[]; notes: string[]; saving: boolean }>({
  tags: [],
  notes: [],
  saving: false,
});
const newTag = ref("");
const newNote = ref("");

// Заменяем старый openClientDetail — теперь грузим с сервера
async function openClientDetail(clientId?: string) {
  if (!clientId) return;
  selectedClientId.value = clientId;
  clientCard.value = null;
  clientCardLoading.value = true;
  try {
    const res = await api.getClientCard(businessId, clientId);
    clientCard.value = res;
    clientCrmDraft.tags = [...res.client.tags];
    clientCrmDraft.notes = [...res.client.notes];
  } finally {
    clientCardLoading.value = false;
  }
}

function addTag() {
  const t = newTag.value.trim();
  if (t && !clientCrmDraft.tags.includes(t)) clientCrmDraft.tags.push(t);
  newTag.value = "";
}
function removeTag(tag: string) {
  clientCrmDraft.tags = clientCrmDraft.tags.filter((t) => t !== tag);
}
function addNote() {
  const n = newNote.value.trim();
  if (n) clientCrmDraft.notes.push(n);
  newNote.value = "";
}
function removeNote(idx: number) {
  clientCrmDraft.notes.splice(idx, 1);
}

async function saveClientCrm() {
  if (!selectedClientId.value) return;
  clientCrmDraft.saving = true;
  try {
    const res = await api.updateClientCrm(businessId, selectedClientId.value, {
      tags: clientCrmDraft.tags,
      notes: clientCrmDraft.notes,
    });
    if (clientCard.value) clientCard.value.client = res.client;
  } finally {
    clientCrmDraft.saving = false;
  }
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

// ---- Маркетинговые рассылки ----
  import type { Campaign, CampaignFilters, CampaignSegment } from "../../../composables/useTimioAuthApi";

  const campaignsList = ref<Campaign[]>([]);
  const campaignsStatus = ref<"idle" | "loading" | "ready" | "error">("idle");

  const campaignDraft = reactive<{
    name: string;
    message: string;
    filters: CampaignFilters;
  }>({
    name: "",
    message: "",
    filters: { segment: "all" },
  });

  const campaignPreview = ref<{ count: number; sample: { id: string; name: string }[] } | null>(null);
  const previewLoading = ref(false);
  const campaignSending = ref(false);
  const campaignError = ref("");
  const campaignSuccess = ref("");

  const segmentLabels: Record<CampaignSegment, string> = {
    all: "Все клиенты",
    inactive: "Давно не приходили",
    by_tag: "По тегу",
    top_clients: "Постоянные клиенты",
    new_clients: "Новые клиенты (1–2 визита)",
  };

  // Уникальные теги всех клиентов - для выпадающего списка в фильтре by_tag
  const allClientTags = computed(() => {
    // clients уже загружены в loadAll, но если нет - пустой массив
    const tagSet = new Set<string>();
    // Используем appointments для получения clientId-ов, но теги нам нужны из CRM.
    // Простое решение: запрашиваем /clients один раз при открытии таба.
    return [...tagSet];
  });

  async function loadCampaigns() {
    campaignsStatus.value = "loading";
    try {
      const res = await api.listCampaigns(businessId);
      campaignsList.value = res.campaigns;
      campaignsStatus.value = "ready";
    } catch {
      campaignsStatus.value = "error";
    }
  }

  async function previewCampaign() {
    campaignPreview.value = null;
    previewLoading.value = true;
    try {
      campaignPreview.value = await api.previewCampaign(businessId, campaignDraft.filters);
    } finally {
      previewLoading.value = false;
    }
  }

  async function sendCampaign() {
    if (!campaignDraft.name.trim() || !campaignDraft.message.trim()) return;
    campaignError.value = "";
    campaignSuccess.value = "";
    campaignSending.value = true;
    try {
      const res = await api.sendCampaign(businessId, {
        name: campaignDraft.name,
        message: campaignDraft.message,
        filters: campaignDraft.filters,
      });
      campaignsList.value.unshift(res.campaign);
      campaignSuccess.value = `Отправлено: ${res.result.sent} из ${res.result.total}`;
      // Сбрасываем форму
      campaignDraft.name = "";
      campaignDraft.message = "";
      campaignDraft.filters = { segment: "all" };
      campaignPreview.value = null;
    } catch (e: any) {
      campaignError.value = e?.message ?? "Не удалось отправить рассылку";
    } finally {
      campaignSending.value = false;
    }
  }

  function formatCampaignStatus(status: string) {
    return { sending: "Отправляется…", sent: "Отправлена", failed: "Ошибка" }[status] ?? status;
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
  if (t === "templates" && templatesStatus.value === "idle") loadTemplates(); 
  if (t === "team" && membersStatus.value === "idle") loadMembers(); 
  if (t === "campaigns" && campaignsStatus.value === "idle") loadCampaigns();       
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
      <a class="sidebar-nav-item" :class="{ active: tab === 'templates' }" @click="openTab('templates')"><span class="nav-icon">✉</span> Шаблоны</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'team' }" @click="openTab('team')"><span class="nav-icon">◎</span> Команда</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'campaigns' }" @click="openTab('campaigns')"><span class="nav-icon">📣</span> Рассылки</a>
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

                <!-- Шаблоны уведомлений -->
        <div v-else-if="tab === 'templates'">
          <div v-if="templatesStatus === 'loading'" class="text-dim">Загрузка…</div>
          <div v-else-if="templatesStatus === 'error'" class="error-banner">Не удалось загрузить шаблоны.</div>

          <template v-else>
            <p class="page-subtitle" style="margin-bottom:6px;font-weight:700;color:var(--text)">Шаблоны уведомлений</p>
            <p class="helper-text" style="margin-bottom:20px">
              Доступные переменные: <code>{{clientName}}</code>, <code>{{serviceName}}</code>,
              <code>{{staffName}}</code>, <code>{{date}}</code>, <code>{{time}}</code>
            </p>

            <div v-for="tmpl in templates" :key="tmpl.type" class="panel" style="margin-bottom:14px">
              <p class="field-label" style="margin-bottom:12px">{{ tmpl.type }}</p>

              <div v-for="locale in LOCALES" :key="locale" class="field" style="margin-bottom:8px">
                <label class="field-label" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">
                  {{ locale }}
                </label>
                <textarea
                  v-model="templateDrafts[tmpl.type][locale]"
                  rows="2"
                  style="width:100%;resize:vertical;font-size:13px"
                />
              </div>

              <button
                class="btn-secondary"
                style="margin-top:8px"
                :disabled="templateSaving[tmpl.type]"
                @click="saveTemplate(tmpl.type)"
              >
                {{ templateSaving[tmpl.type] ? "…" : "Сохранить" }}
              </button>
            </div>
          </template>
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

                <!-- Команда бизнеса -->
        <div v-else-if="tab === 'team'">
          <div class="panel" style="max-width:480px; margin-bottom:20px">
            <p class="field-label" style="margin-bottom:12px">Добавить участника</p>
            <p class="helper-text" style="margin-bottom:12px">
              Пользователь должен быть уже зарегистрирован в Timio.
            </p>
            <div v-if="memberError" class="error-banner">{{ memberError }}</div>
            <div class="field">
              <label class="field-label">Email</label>
              <input v-model="newMemberEmail" type="email" placeholder="colleague@example.com" />
            </div>
            <div class="field">
              <label class="field-label">Роль</label>
              <select v-model="newMemberRole">
                <option value="administrator">Администратор</option>
                <option value="manager">Менеджер</option>
                <option value="employee">Сотрудник</option>
              </select>
            </div>
            <button class="btn-secondary" :disabled="addingMember" @click="addMember">
              {{ addingMember ? "…" : "+ Добавить" }}
            </button>
          </div>

          <div v-if="membersStatus === 'loading'" class="text-dim">Загрузка…</div>
          <div v-else-if="membersStatus === 'error'" class="error-banner">Не удалось загрузить команду.</div>
          <div v-else>
            <div v-for="m in members" :key="m.id" class="data-row">
              <div style="display:flex; align-items:center; gap:12px">
                <span class="avatar-circle" style="background:var(--accent)">{{ initials(m.name) }}</span>
                <div>
                  <div style="font-weight:600; font-size:14px">{{ m.name }}</div>
                  <div class="text-dim text-xs">{{ m.email }}</div>
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:12px">
                <span class="badge">{{ m.role }}</span>
                <button
                  v-if="m.role !== 'owner'"
                  class="btn-danger-text"
                  @click="removeMember(m.id)"
                >Удалить</button>
              </div>
            </div>
          </div>
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
                    <div class="text-dim text-xs">До 3 сотрудников · 1990 ₽/мес</div>
                  </div>
                </label>
                <label class="option" style="cursor: pointer">
                  <input type="radio" value="business" v-model="selectedPlan" style="margin-right: 10px; width: auto" />
                  <div>
                    <div style="font-weight: 700">Бизнес</div>
                    <div class="text-dim text-xs">3190 ₽/мес + 390 ₽ за каждого сотрудника сверх 3</div>
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

        <!-- Маркетинговые рассылки -->
<div v-else-if="tab === 'campaigns'">

  <!-- Форма новой рассылки -->
  <div class="panel" style="max-width: 560px; margin-bottom: 24px">
    <p class="field-label" style="margin-bottom: 14px">Новая рассылка</p>

    <div v-if="campaignError" class="error-banner">{{ campaignError }}</div>
    <div v-if="campaignSuccess" class="helper-text" style="color: var(--success); margin-bottom: 12px">
      ✓ {{ campaignSuccess }}
    </div>

    <!-- Название -->
    <div class="field">
      <label class="field-label">Название (для истории)</label>
      <input v-model="campaignDraft.name" type="text" placeholder="Акция май, возврат клиентов…" />
    </div>

    <!-- Сегмент -->
    <div class="field">
      <label class="field-label">Кому отправить</label>
      <select v-model="campaignDraft.filters.segment" @change="campaignPreview = null">
        <option v-for="(label, seg) in segmentLabels" :key="seg" :value="seg">{{ label }}</option>
      </select>
    </div>

    <!-- Доп. параметры сегмента -->
    <div v-if="campaignDraft.filters.segment === 'inactive'" class="field">
      <label class="field-label">Не приходили более (дней)</label>
      <input
        v-model.number="campaignDraft.filters.inactiveDays"
        type="number"
        min="7"
        step="1"
        style="max-width: 120px"
        placeholder="30"
        @change="campaignPreview = null"
      />
    </div>

    <div v-if="campaignDraft.filters.segment === 'by_tag'" class="field">
      <label class="field-label">Тег</label>
      <input
        v-model="campaignDraft.filters.tag"
        type="text"
        placeholder="vip, скидка…"
        @change="campaignPreview = null"
      />
    </div>

    <div v-if="campaignDraft.filters.segment === 'top_clients'" class="field">
      <label class="field-label">Минимум визитов</label>
      <input
        v-model.number="campaignDraft.filters.visitsGte"
        type="number"
        min="1"
        style="max-width: 120px"
        placeholder="5"
        @change="campaignPreview = null"
      />
    </div>

    <!-- Текст сообщения -->
    <div class="field">
      <label class="field-label">Текст сообщения</label>
      <textarea
        v-model="campaignDraft.message"
        rows="4"
        style="width: 100%; resize: vertical"
        placeholder="Привет, {{clientName}}! Мы скучаем — возвращайтесь, для вас скидка 10% 🎁"
      />
      <p class="helper-text" style="margin-top: 4px">
        Переменные: <code>{{clientName}}</code>, <code>{{businessName}}</code>
      </p>
    </div>

    <!-- Превью получателей -->
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px">
      <button class="btn-secondary" :disabled="previewLoading" @click="previewCampaign">
        {{ previewLoading ? "…" : "Посмотреть получателей" }}
      </button>
      <span v-if="campaignPreview" class="text-dim" style="font-size: 13px">
        Получат:
        <b style="color: var(--text)">{{ campaignPreview.count }}</b> клиентов
        <template v-if="campaignPreview.sample.length">
          ({{ campaignPreview.sample.map(s => s.name).join(", ") }}{{ campaignPreview.count > 5 ? "…" : "" }})
        </template>
        <template v-else-if="campaignPreview.count === 0">
          — никто не попал в выборку
        </template>
      </span>
    </div>

    <button
      class="btn-primary"
      :disabled="campaignSending || !campaignDraft.name.trim() || !campaignDraft.message.trim()"
      @click="sendCampaign"
    >
      {{ campaignSending ? "Отправляем…" : "Отправить рассылку" }}
    </button>
  </div>

    <!-- История рассылок -->
    <p class="page-subtitle" style="margin-bottom: 12px; font-weight: 700; color: var(--text)">
      История рассылок
    </p>

    <div v-if="campaignsStatus === 'loading'" class="text-dim">Загрузка…</div>
    <div v-else-if="campaignsStatus === 'error'" class="error-banner">Не удалось загрузить историю.</div>

    <div v-else-if="campaignsList.length === 0" class="empty-state panel">
      <div class="title">Рассылок пока не было</div>
      <p>Создайте первую рассылку выше — она уйдёт клиентам в Telegram.</p>
    </div>

    <div v-for="camp in campaignsList" :key="camp.id" class="data-row">
      <div>
        <div style="font-weight: 600; font-size: 14px">{{ camp.name }}</div>
        <div class="text-dim text-xs">
          {{ segmentLabels[camp.filters.segment as CampaignSegment] }} ·
          {{ camp.sentAt ? formatDateTime(camp.sentAt) : "—" }}
        </div>
        <div class="text-dim text-xs" style="margin-top: 2px; font-style: italic">
          {{ camp.message.slice(0, 60) }}{{ camp.message.length > 60 ? "…" : "" }}
        </div>
      </div>
      <div style="text-align: right">
        <span
          class="badge"
          :style="camp.status === 'sent'
            ? 'background:var(--success-dim);color:var(--success)'
            : camp.status === 'failed'
            ? 'background:var(--danger-dim);color:var(--danger)'
            : ''"
        >
          {{ formatCampaignStatus(camp.status) }}
        </span>
        <div class="text-dim text-xs" style="margin-top: 4px">
          {{ camp.sentCount }} / {{ camp.recipientCount }} доставлено
        </div>
      </div>
    </div>

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

    <!-- CRM: полная карточка клиента -->
    <Modal v-if="selectedClientId" :title="clientCard?.client.name ?? '…'" @close="selectedClientId = null">
      <div v-if="clientCardLoading" class="text-dim" style="padding:20px 0">Загрузка…</div>

      <template v-else-if="clientCard">
        <!-- Контакты -->
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:16px">
          <div class="stat-card" style="padding:10px">
            <div class="stat-label">Визитов</div>
            <div class="stat-value" style="font-size:20px">{{ clientCard.client.visits }}</div>
          </div>
          <div class="stat-card" style="padding:10px">
            <div class="stat-label">Потрачено</div>
            <div class="stat-value" style="font-size:20px">{{ formatMoney(clientCard.client.totalSpentCents) }}</div>
          </div>
        </div>

        <div class="text-dim text-xs" style="margin-bottom:16px">
          <span v-if="clientCard.client.phone">📞 {{ clientCard.client.phone }} &nbsp;</span>
          <span v-if="clientCard.client.email">✉ {{ clientCard.client.email }} &nbsp;</span>
          <span v-if="clientCard.client.telegramChatId">✈ Telegram подключён &nbsp;</span>
          <span>🌐 {{ clientCard.client.detectedLocale }}</span>
        </div>

        <!-- Теги -->
        <div style="margin-bottom:16px">
          <p class="field-label" style="margin-bottom:8px">Теги</p>
          <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px">
            <span
              v-for="tag in clientCrmDraft.tags" :key="tag"
              class="badge"
              style="cursor:pointer"
              @click="removeTag(tag)"
            >{{ tag }} ✕</span>
          </div>
          <div style="display:flex; gap:8px">
            <input v-model="newTag" type="text" placeholder="Новый тег" style="flex:1" @keydown.enter="addTag" />
            <button class="btn-secondary" @click="addTag">+</button>
          </div>
        </div>

        <!-- Заметки -->
        <div style="margin-bottom:16px">
          <p class="field-label" style="margin-bottom:8px">Заметки</p>
          <div v-for="(note, idx) in clientCrmDraft.notes" :key="idx" class="data-row" style="padding:6px 0">
            <span style="font-size:13px">{{ note }}</span>
            <button class="btn-danger-text" @click="removeNote(idx)">✕</button>
          </div>
          <div style="display:flex; gap:8px; margin-top:8px">
            <input v-model="newNote" type="text" placeholder="Добавить заметку" style="flex:1" @keydown.enter="addNote" />
            <button class="btn-secondary" @click="addNote">+</button>
          </div>
        </div>

        <button class="btn-primary" :disabled="clientCrmDraft.saving" @click="saveClientCrm" style="margin-bottom:20px">
          {{ clientCrmDraft.saving ? "…" : "Сохранить CRM" }}
        </button>

        <!-- История записей -->
        <p class="field-label" style="margin-bottom:10px">История записей</p>
        <div v-if="clientCard.appointments.length === 0" class="text-dim text-xs">Нет записей</div>
        <div v-for="a in clientCard.appointments" :key="a.id" class="data-row">
          <div>
            <div style="font-weight:600; font-size:14px">{{ a.serviceName }}</div>
            <div class="text-dim text-xs">{{ a.staffName }} · {{ formatDateTime(a.startAt) }}</div>
          </div>
          <div style="display:flex; align-items:center; gap:8px">
            <span class="badge" :class="`status-${a.status}`">{{ a.status }}</span>
            <span class="mono text-dim text-xs">{{ formatMoney(a.priceCents, a.currency) }}</span>
          </div>
        </div>
      </template>
    </Modal>

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
        <select
          :value="a.status"
          style="font-size:11px; padding:2px 4px; border-radius:6px; border:1px solid var(--border); background:var(--surface); color:var(--text)"
          @change="changeAppointmentStatus(a.id, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
        </select>
        <select
          :value="a.status"
          class="text-xs"
          style="font-size:11px; padding:2px 4px; border-radius:6px; border:1px solid var(--border); background:var(--surface); color:var(--text)"
          @change="changeAppointmentStatus(a.id, ($event.target as HTMLSelectElement).value)"
        >
      <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
    </select>
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
