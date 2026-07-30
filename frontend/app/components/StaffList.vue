<script setup lang="ts">
import { useBookingStore } from "../stores/booking";

const store = useBookingStore();

function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}
</script>

<template>
  <div v-if="store.page">
    <p class="step-label">{{ store.page.ui.chooseStaff }}</p>
    <div class="flex flex-col gap-2">
      <button
        v-for="member in store.eligibleStaff"
        :key="member.id"
        class="option"
        @click="store.chooseStaff(member.id)"
      >
        <div style="display: flex; align-items: center; gap: 12px">
          <img v-if="member.photoUrl" :src="member.photoUrl" class="option-avatar" alt="" />
          <span v-else class="option-avatar-fallback" :style="{ background: member.colorHex }">
            {{ initials(member.name) }}
          </span>
          {{ member.name }}
        </div>
      </button>
    </div>
  </div>
</template>
