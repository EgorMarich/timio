<script setup lang="ts">
import { computed } from "vue";
import { useBookingStore } from "../stores/booking";

const store = useBookingStore();

// 14 ближайших дней - клиент выбирает дату, а не только время (по запросу).
const days = computed(() => {
  const result: { iso: string; label: string; weekday: string }[] = [];
  const locale = store.page?.locale ?? "en";
  for (let i = 0; i < 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    result.push({
      iso: d.toISOString().slice(0, 10),
      label: d.toLocaleDateString(locale, { day: "numeric", month: "short" }),
      weekday: d.toLocaleDateString(locale, { weekday: "short" }),
    });
  }
  return result;
});
</script>

<template>
  <div v-if="store.page">
    <p class="step-label">{{ store.page.ui.chooseDate ?? "Choose a date" }}</p>
    <div class="date-strip">
      <button
        v-for="d in days"
        :key="d.iso"
        class="date-chip"
        :class="{ selected: store.date === d.iso }"
        @click="store.chooseDate(d.iso)"
      >
        <span class="date-chip-weekday">{{ d.weekday }}</span>
        <span class="date-chip-label">{{ d.label }}</span>
      </button>
    </div>
  </div>
</template>
