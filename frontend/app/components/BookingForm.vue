<script setup lang="ts">
import { ref } from "vue";
import { useBookingStore } from "../stores/booking";
import { useTimioApi } from "../composables/useTimioApi";

const props = defineProps<{ slug: string }>();
const store = useBookingStore();
const api = useTimioApi();

const clientName = ref("");
const clientPhone = ref("");

async function submit() {
  if (!clientName.value || !clientPhone.value || !store.serviceId || !store.staffId || !store.slot) return;
  store.submitting = true;
  store.result = await api.submitBooking({
    slug: props.slug,
    serviceId: store.serviceId,
    staffId: store.staffId,
    startAt: store.slot.startAt,
    clientName: clientName.value,
    clientPhone: clientPhone.value,
  });
  store.submitting = false;
  store.step = "done";
}
</script>

<template>
  <div v-if="store.page">
    <p class="step-label">{{ store.page.ui.yourName }}</p>
    <input v-model="clientName" type="text" :placeholder="store.page.ui.yourName" />
    <input v-model="clientPhone" type="tel" :placeholder="store.page.ui.yourPhone" />
    <button class="btn-primary" :disabled="store.submitting" @click="submit">
      {{ store.page.ui.confirmBooking }}
    </button>
  </div>
</template>
