<script setup lang="ts">
import { ref } from "vue";
import { fileToDataUrl } from "../utils/file";

const props = defineProps<{ modelValue?: string | null; shape?: "circle" | "square" }>();
const emit = defineEmits<{ (e: "update:modelValue", value: string | null): void }>();

const inputEl = ref<HTMLInputElement | null>(null);
const loading = ref(false);

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 3 * 1024 * 1024) {
    alert("Файл слишком большой (максимум 3 МБ).");
    return;
  }
  loading.value = true;
  try {
    const dataUrl = await fileToDataUrl(file);
    emit("update:modelValue", dataUrl);
  } finally {
    loading.value = false;
  }
}

function remove() {
  emit("update:modelValue", null);
  if (inputEl.value) inputEl.value.value = "";
}
</script>

<template>
  <div class="photo-upload" :class="shape === 'square' ? 'photo-upload-square' : 'photo-upload-circle'">
    <div class="photo-upload-preview" @click="inputEl?.click()">
      <img v-if="modelValue" :src="modelValue" alt="" />
      <span v-else-if="loading" class="text-xs text-dim">…</span>
      <span v-else class="photo-upload-plus">+</span>
    </div>
    <input ref="inputEl" type="file" accept="image/*" style="display: none" @change="onFileChange" />
    <button v-if="modelValue" class="btn-danger-text" style="margin-top: 4px" @click="remove">Удалить фото</button>
  </div>
</template>
