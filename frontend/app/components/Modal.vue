<script setup lang="ts">
defineProps<{ title: string }>();
const emit = defineEmits<{ (e: "close"): void }>();
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-panel">
      <div class="modal-head">
        <p class="modal-title">{{ title }}</p>
        <button class="modal-close" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <slot />
      </div>
    </div>
  </div>
</template>
