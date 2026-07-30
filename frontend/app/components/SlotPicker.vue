<script setup lang="ts">
import { onMounted, watch, ref } from "vue";
import { useBookingStore } from "../stores/booking";
import { useTimioApi } from "../composables/useTimioApi";

const props = defineProps<{ slug: string }>();
const store = useBookingStore();
const api = useTimioApi();
const loading = ref(true);

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
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div v-if="store.page">
    <p class="step-label">{{ store.page.ui.chooseTime }}</p>
    <p v-if="loading" class="empty">…</p>
    <p v-else-if="store.slots.length === 0" class="empty">{{ store.page.ui.noSlotsToday }}</p>
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
  </div>
</template>
