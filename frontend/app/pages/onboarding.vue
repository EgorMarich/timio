<script setup lang="ts">
import { ref } from "vue";
import { useTimioAuthApi } from "../composables/useTimioAuthApi";

definePageMeta({ middleware: "auth" });

const api = useTimioAuthApi();
const router = useRouter();

type Step = "business" | "services" | "staff" | "done";
const step = ref<Step>("business");
const error = ref("");
const loading = ref(false);

// Шаг 1: компания
const bizName = ref("");
const niche = ref("barbershop");
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Moscow");
const businessId = ref("");
const businessSlug = ref("");

const niches = [
  { value: "barbershop", label: "Барбершоп" },
  { value: "beauty_salon", label: "Салон красоты" },
  { value: "dental", label: "Стоматология" },
  { value: "massage", label: "Массаж / SPA" },
  { value: "psychology", label: "Психолог / консультант" },
  { value: "tutoring", label: "Репетитор" },
  { value: "vet", label: "Ветклиника" },
  { value: "auto_service", label: "Автосервис" },
  { value: "other", label: "Другое" },
];

async function createBusiness() {
  error.value = "";
  if (!bizName.value.trim()) {
    error.value = "Введите название компании.";
    return;
  }
  loading.value = true;
  try {
    const res = await api.createBusiness({ name: bizName.value, niche: niche.value, timezone: timezone.value });
    businessId.value = res.business.id;
    businessSlug.value = res.business.slug;
    step.value = "services";
  } catch {
    error.value = "Не удалось создать компанию. Проверьте соединение с API.";
  } finally {
    loading.value = false;
  }
}

// Шаг 2: услуги (у каждого бизнеса свои)
interface DraftService { name: string; durationMin: number; priceCents: number; currency: string }
const services = ref<DraftService[]>([]);
const draftName = ref("");
const draftDuration = ref(30);
const draftPrice = ref(0);
const draftCurrency = ref("RUB");

async function addService() {
  if (!draftName.value.trim() || !draftDuration.value || draftPrice.value < 0) return;
  loading.value = true;
  try {
    await api.createService(businessId.value, {
      name: draftName.value,
      durationMin: draftDuration.value,
      priceCents: Math.round(draftPrice.value * 100),
      currency: draftCurrency.value,
    });
    services.value.push({ name: draftName.value, durationMin: draftDuration.value, priceCents: draftPrice.value * 100, currency: draftCurrency.value });
    draftName.value = "";
    draftDuration.value = 30;
    draftPrice.value = 0;
  } catch {
    error.value = "Не удалось добавить услугу.";
  } finally {
    loading.value = false;
  }
}

function goToStaff() {
  if (services.value.length === 0) {
    error.value = "Добавьте хотя бы одну услугу, чтобы клиенты могли записаться.";
    return;
  }
  error.value = "";
  step.value = "staff";
}

// Шаг 3: сотрудник
const staffName = ref("");

async function addStaffAndFinish() {
  loading.value = true;
  try {
    if (staffName.value.trim()) {
      const { services: svcList } = await api.listServices(businessId.value);
      await api.createStaff(businessId.value, {
        name: staffName.value,
        serviceIds: svcList.map((s) => s.id),
      });
    }
    step.value = "done";
  } catch {
    error.value = "Не удалось добавить сотрудника.";
  } finally {
    loading.value = false;
  }
}

function goToDashboard() {
  router.push(`/app/${businessId.value}`);
}
</script>

<template>
  <div class="centered-shell">
    <div class="glow" />
    <div class="auth-card" style="max-width: 460px">
      <div class="brand">
        <span class="brand-mark">T</span>
        <span class="brand-name">Timio</span>
      </div>

      <div v-if="error" class="error-banner">{{ error }}</div>

      <!-- Шаг 1 -->
      <template v-if="step === 'business'">
        <h1 class="page-title">Расскажите о вашей компании</h1>
        <p class="page-subtitle">Это займёт меньше минуты. Ссылку для клиентов сгенерируем автоматически.</p>

        <div class="field">
          <label class="field-label">Название компании</label>
          <input v-model="bizName" type="text" placeholder="Например: Салон красоты Мария" />
        </div>
        <div class="field">
          <label class="field-label">Сфера деятельности</label>
          <select v-model="niche">
            <option v-for="n in niches" :key="n.value" :value="n.value">{{ n.label }}</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label">Часовой пояс</label>
          <input v-model="timezone" type="text" />
          <p class="helper-text">Определён автоматически по вашему браузеру.</p>
        </div>
        <button class="btn-primary" :disabled="loading" @click="createBusiness">
          {{ loading ? "…" : "Продолжить" }}
        </button>
      </template>

      <!-- Шаг 2 -->
      <template v-else-if="step === 'services'">
        <h1 class="page-title">Добавьте свои услуги</h1>
        <p class="page-subtitle">
          У каждой компании свой набор услуг и цен — добавьте то, что предлагаете именно вы.
        </p>

        <div v-if="services.length" class="mt-4" style="margin-bottom: 16px">
          <div v-for="(s, i) in services" :key="i" class="data-row">
            <div>
              <div style="font-weight: 600; font-size: 14px">{{ s.name }}</div>
              <div class="text-dim text-xs">{{ s.durationMin }} мин</div>
            </div>
            <div class="mono text-dim" style="font-size: 13px">{{ (s.priceCents / 100).toFixed(0) }} {{ s.currency }}</div>
          </div>
        </div>

        <div class="field">
          <label class="field-label">Название услуги</label>
          <input v-model="draftName" type="text" placeholder="Например: Маникюр классический" />
        </div>
        <div style="display: flex; gap: 10px">
          <div class="field" style="flex: 1">
            <label class="field-label">Длительность (мин)</label>
            <input v-model.number="draftDuration" type="number" min="5" step="5" />
          </div>
          <div class="field" style="flex: 1">
            <label class="field-label">Цена</label>
            <input v-model.number="draftPrice" type="number" min="0" step="1" />
          </div>
          <div class="field" style="width: 90px">
            <label class="field-label">Валюта</label>
            <select v-model="draftCurrency">
              <option>RUB</option>
              <option>USD</option>
              <option>EUR</option>
              <option>KZT</option>
              <option>AMD</option>
            </select>
          </div>
        </div>
        <button class="btn-secondary" style="width: 100%; margin-bottom: 12px" :disabled="loading" @click="addService">
          + Добавить услугу
        </button>
        <button class="btn-primary" :disabled="loading" @click="goToStaff">Продолжить</button>
      </template>

      <!-- Шаг 3 -->
      <template v-else-if="step === 'staff'">
        <h1 class="page-title">Добавьте сотрудника</h1>
        <p class="page-subtitle">Можно пропустить и добавить позже в панели управления.</p>

        <div class="field">
          <label class="field-label">Имя сотрудника</label>
          <input v-model="staffName" type="text" placeholder="Например: Мастер Ольга" />
        </div>
        <button class="btn-primary" :disabled="loading" @click="addStaffAndFinish">
          {{ loading ? "…" : staffName.trim() ? "Добавить и завершить" : "Пропустить" }}
        </button>
      </template>

      <!-- Готово -->
      <template v-else>
        <h1 class="page-title">Всё готово 🎉</h1>
        <p class="page-subtitle">
          Ваша страница записи: <br />
          <code class="mono">timio.app/{{ businessSlug }}</code>
        </p>
        <button class="btn-primary" @click="goToDashboard">Перейти в панель управления</button>
      </template>
    </div>
  </div>
</template>
