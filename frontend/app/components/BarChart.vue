<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  data: { label: string; value: number }[];
  formatValue?: (v: number) => string;
  color?: string;
}>();

const maxValue = computed(() => Math.max(1, ...props.data.map((d) => d.value)));
const barColor = computed(() => props.color ?? "var(--accent)");

function format(v: number) {
  return props.formatValue ? props.formatValue(v) : String(v);
}
</script>

<template>
  <div class="bar-chart">
    <div v-if="data.length === 0" class="empty" style="padding: 24px 0">Пока нет данных</div>
    <div v-else class="bar-chart-row" v-for="d in data" :key="d.label">
      <span class="bar-chart-label">{{ d.label }}</span>
      <div class="bar-chart-track">
        <div
          class="bar-chart-fill"
          :style="{ width: (d.value / maxValue) * 100 + '%', background: barColor }"
        />
      </div>
      <span class="bar-chart-value mono">{{ format(d.value) }}</span>
    </div>
  </div>
</template>
