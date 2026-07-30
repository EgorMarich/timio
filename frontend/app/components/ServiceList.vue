<script setup lang="ts">
import { useBookingStore } from "../stores/booking";

const store = useBookingStore();
</script>

<template>
  <div v-if="store.page">
    <p class="step-label">{{ store.page.ui.chooseService }}</p>
    <div class="flex flex-col gap-2">
      <button
        v-for="service in store.page.services"
        :key="service.id"
        class="option"
        @click="store.chooseService(service.id)"
      >
        <div style="display: flex; align-items: center; gap: 12px; text-align: left">
          <img v-if="service.photoUrl" :src="service.photoUrl" class="option-photo" alt="" />
          <div>
            <div>{{ service.name }}</div>
            <div class="meta">{{ service.durationMin }} {{ store.page.ui.minutes }}</div>
          </div>
        </div>
        <div>{{ (service.priceCents / 100).toFixed(0) }} {{ service.currency }}</div>
      </button>
    </div>
  </div>
</template>
