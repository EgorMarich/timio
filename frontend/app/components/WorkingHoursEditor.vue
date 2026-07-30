<script setup lang="ts">
import { reactive, watch } from "vue";
import type { WorkingHours } from "../composables/useTimioAuthApi";

const props = defineProps<{
  modelValue: WorkingHours;
  /** Если true - показывает переключатель "своё расписание / как у бизнеса". */
  allowInherit?: boolean;
  inherited?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", value: WorkingHours): void;
  (e: "update:inherited", value: boolean): void;
}>();

const DAYS = [
  { key: 1, label: "Пн" },
  { key: 2, label: "Вт" },
  { key: 3, label: "Ср" },
  { key: 4, label: "Чт" },
  { key: 5, label: "Пт" },
  { key: 6, label: "Сб" },
  { key: 0, label: "Вс" },
];

function minutesToHHMM(m: number) {
  const h = Math.floor(m / 60)
    .toString()
    .padStart(2, "0");
  const mm = (m % 60).toString().padStart(2, "0");
  return `${h}:${mm}`;
}
function hhmmToMinutes(s: string) {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

// Локальная реактивная копия, чтобы можно было редактировать поля по отдельности
// и эмитить наверх цельный объект WorkingHours при каждом изменении.
const local = reactive<WorkingHours>({ ...props.modelValue });

watch(
  () => props.modelValue,
  (v) => Object.assign(local, v),
  { deep: true }
);

function toggleDay(day: number) {
  local[day] = local[day] ? null : { start: 600, end: 1200 };
  emit("update:modelValue", { ...local });
}
function updateStart(day: number, value: string) {
  if (!local[day]) return;
  local[day] = { ...local[day]!, start: hhmmToMinutes(value) };
  emit("update:modelValue", { ...local });
}
function updateEnd(day: number, value: string) {
  if (!local[day]) return;
  local[day] = { ...local[day]!, end: hhmmToMinutes(value) };
  emit("update:modelValue", { ...local });
}
</script>

<template>
  <div>
    <label v-if="allowInherit" class="working-hours-inherit">
      <input
        type="checkbox"
        :checked="!inherited"
        @change="$emit('update:inherited', !($event.target as HTMLInputElement).checked)"
      />
      Индивидуальное расписание (иначе — как у бизнеса по умолчанию)
    </label>

    <div v-if="!allowInherit || !inherited" class="working-hours-grid">
      <div v-for="d in DAYS" :key="d.key" class="working-hours-row">
        <label class="working-hours-day">
          <input type="checkbox" :checked="!!local[d.key]" @change="toggleDay(d.key)" />
          {{ d.label }}
        </label>
        <template v-if="local[d.key]">
          <input
            type="text"
            class="working-hours-time"
            :value="minutesToHHMM(local[d.key]!.start)"
            @change="updateStart(d.key, ($event.target as HTMLInputElement).value)"
          />
          <span class="text-dim">—</span>
          <input
            type="text"
            class="working-hours-time"
            :value="minutesToHHMM(local[d.key]!.end)"
            @change="updateEnd(d.key, ($event.target as HTMLInputElement).value)"
          />
        </template>
        <span v-else class="text-dim text-xs">выходной</span>
      </div>
    </div>
  </div>
</template>
