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

type Tab = "overview" | "appointments" | "services" | "staff" | "analytics" | "settings";
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

const appointmentsByStaff = computed(() => {
  return staff.value.map((member) => ({
    staff: member,
    appointments: appointments.value
      .filter((a) => a.staffId === member.id)
      .sort((a, b) => a.startAt.localeCompare(b.startAt)),
  }));
});

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

function openTab(t: Tab) {
  tab.value = t;
  if (t === "analytics" && analyticsStatus.value === "idle") loadAnalytics();
  if (t === "settings") loadBusinessDraft();
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
      <a class="sidebar-nav-item" :class="{ active: tab === 'services' }" @click="openTab('services')"><span class="nav-icon">◇</span> Услуги</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'staff' }" @click="openTab('staff')"><span class="nav-icon">◍</span> Сотрудники</a>
      <a class="sidebar-nav-item" :class="{ active: tab === 'analytics' }" @click="openTab('analytics')"><span class="nav-icon">▲</span> Аналитика</a>
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
                <div style="font-weight: 600; font-size: 14px">{{ a.clientName }}</div>
                <div class="text-dim text-xs">{{ a.serviceName }} · {{ a.staffName }} · {{ formatDateTime(a.startAt) }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Записи: колоночное расписание по сотрудникам -->
        <div v-else-if="tab === 'appointments'">
          <div v-if="staff.length === 0" class="empty-state panel">
            <div class="title">Сначала добавьте сотрудников</div>
            <p>Расписание группируется по сотрудникам — добавьте хотя бы одного во вкладке «Сотрудники».</p>
          </div>
          <div v-else class="schedule-board">
            <div v-for="col in appointmentsByStaff" :key="col.staff.id" class="schedule-column">
              <div class="schedule-column-head">
                <img v-if="col.staff.photoUrl" :src="col.staff.photoUrl" class="option-avatar" alt="" />
                <span v-else class="avatar-circle" :style="{ background: col.staff.colorHex }">{{ initials(col.staff.name) }}</span>
                <span class="schedule-column-name">{{ col.staff.name }}</span>
              </div>
              <div v-if="col.appointments.length === 0" class="schedule-empty">Нет записей</div>
              <div v-for="a in col.appointments" :key="a.id" class="appointment-card">
                <span class="appointment-time mono">{{ formatTime(a.startAt) }}</span>
                <div class="appointment-client">{{ a.clientName }}</div>
                <div class="appointment-service text-dim text-xs">{{ a.serviceName }}</div>
                <span class="badge mt-4" :class="`status-${a.status}`" style="margin-top: 8px">{{ a.status }}</span>
              </div>
            </div>
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

        <!-- Настройки -->
        <div v-else-if="tab === 'settings'">
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
  </div>
</template>
