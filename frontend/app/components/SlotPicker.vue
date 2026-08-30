<script setup lang="ts">
import { onMounted, watch, ref } from "vue";
import { useBookingStore } from "../stores/booking";
import { useTimioApi } from "../composables/useTimioApi";
// 👇 1. Добавили импорт модалки
import WaitlistJoinModal from "./WaitlistJoinModal.vue";

const props = defineProps<{ slug: string }>();
const store = useBookingStore();
const api = useTimioApi();
const loading = ref(true);

// 👇 2. Добавили ref для показа модалки
const showWaitlistModal = ref(false);

async function load() {
  if (!store.serviceId || !store.staffId || !store.date) return;
  loading.value = true;
  store.slots = await api.fetchAvailability({
    slug: props.slug,
    serviceId: store.serviceId,
    staffId: store.staffId,
    date: store.date,
  });
  loading.value = false;
}

onMounted(load);
watch(() => store.date, load);

function formatTime(iso: string, locale: string) {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<template>
  <div v-if="store.page">
    <p class="step-label">{{ store.page.ui.chooseTime }}</p>

    <!-- Загрузка -->
    <p v-if="loading" class="empty">…</p>

    <!-- 👇 3. Вместо простого текста "нет слотов" — кнопка записи в очередь -->
    <div v-else-if="store.slots.length === 0" class="no-slots">
      <p class="empty">{{ store.page.ui.noSlotsToday }}</p>
      <button class="no-slots__btn" @click="showWaitlistModal = true">
        🔔 Записаться в очередь ожидания
      </button>
      <p class="no-slots__hint">
        Если кто-то отменит запись — мы сразу вас уведомим
      </p>
    </div>

    <!-- Слоты — без изменений -->
    <div v-else class="grid grid-cols-3 gap-2">
      <button
        v-for="slot in store.slots.slice(0, 12)"
        :key="slot.startAt"
        class="slot"
        @click="store.chooseSlot(slot)"
      >
        {{ formatTime(slot.startAt, store.page.locale) }}
      </button>
    </div>

    <!-- 👇 4. Модалка — появляется поверх всего через Teleport -->
    <WaitlistJoinModal
      v-if="showWaitlistModal"
      :business-id="store.page.business.id"
      :service-id="store.serviceId!"
      :staff-id="store.staffId ?? null"
      :start-at="`${store.date}T00:00:00.000Z`"
      :end-at="`${store.date}T23:59:59.000Z`"
      @close="showWaitlistModal = false"
      @joined="showWaitlistModal = false"
    />
  </div>
</template>

<style scoped>
/* 👇 5. Стили для блока "нет слотов" */
.no-slots {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
}

.no-slots__btn {
  padding: 10px 20px;
  background: #f59e0b;
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.no-slots__btn:hover {
  background: #d97706;
}

.no-slots__hint {
  font-size: 12px;
  color: #999;
  text-align: center;
}
</style>