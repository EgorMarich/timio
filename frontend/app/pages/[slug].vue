<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import { useBookingStore } from "../stores/booking";
import { useTimioApi } from "../composables/useTimioApi";

const route = useRoute();
const slug = route.params.slug as string;

const store = useBookingStore();
const api = useTimioApi();

const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");

const steps = ["service", "staff", "date", "time", "details", "done"] as const;
const stepperSteps = computed(() => steps.slice(0, 5)); // "done" не показываем в прогресс-баре

async function load() {
  status.value = "loading";
  try {
    const page = await api.fetchBusinessPage(slug);
    store.setPage(page);
    status.value = "ready";
  } catch (e) {
    status.value = "error";
    errorMessage.value = e instanceof Error ? e.message : "Unknown error";
  }
}

onMounted(load);
</script>

<template>
  <div class="shell">
    <div class="glow" />

    <!-- Загрузка -->
    <div v-if="status === 'loading'" class="card">
      <div class="skeleton-head">
        <div class="skeleton-line w-40" />
        <div class="skeleton-pill" />
      </div>
      <div class="skeleton-body">
        <div class="skeleton-line w-24 h-3" />
        <div class="skeleton-row" v-for="i in 3" :key="i" />
      </div>
    </div>

    <!-- Ошибка подключения к API -->
    <div v-else-if="status === 'error'" class="card">
      <div class="error-state">
        <div class="error-icon">!</div>
        <h3>Не удалось загрузить страницу записи</h3>
        <p class="text-dim">
          Похоже, backend API недоступен по адресу
          <code>{{ api.apiBase }}</code>. Проверьте, что сервис запущен
          (<code>docker compose up</code> или <code>npm run dev</code> в
          <code>api/</code>).
        </p>
        <p class="text-dim text-xs" v-if="errorMessage">{{ errorMessage }}</p>
        <button class="btn-primary" @click="load">Повторить попытку</button>
      </div>
    </div>

    <!-- Готово -->
    <div v-else class="card">
      <div class="head">
        <div class="head-top">
          <p class="biz-name">{{ store.page!.business.name }}</p>
          <ThemeToggle />
        </div>
        <div class="stepper">
          <span
            v-for="(s, i) in stepperSteps"
            :key="s"
            class="dot"
            :class="{ active: steps.indexOf(store.step) >= i }"
          />
        </div>
      </div>

      <transition name="fade-slide" mode="out-in">
        <div class="body" :key="store.step">
          <div v-if="store.canGoBack" class="body-head-row">
            <button class="back-btn" @click="store.goBack" aria-label="Назад">←</button>
          </div>

          <ServiceList v-if="store.step === 'service'" />
          <StaffList v-else-if="store.step === 'staff'" />
          <DatePicker v-else-if="store.step === 'date'" />
          <SlotPicker v-else-if="store.step === 'time'" :slug="slug" />
          <BookingForm v-else-if="store.step === 'details'" :slug="slug" />
          <ConfirmationCard v-else-if="store.step === 'done'" />
        </div>
      </transition>
    </div>

    <p class="footer-note">Powered by <b>Timio</b></p>
  </div>
</template>
