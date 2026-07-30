<script setup lang="ts">
import { useBookingStore } from "../stores/booking";

const store = useBookingStore();
</script>

<template>
  <div v-if="store.page && store.result" class="text-center py-4">
    <h3 class="text-xl font-bold mb-2">{{ store.page.ui.bookingConfirmedTitle }}</h3>
    <p class="text-[var(--text-dim)] text-sm mb-1">{{ store.page.ui.bookingConfirmedBody }}</p>

    <!--
      Эта плашка - не для конечного клиента, а витрина того, что произошло "под капотом":
      какой канал выбрала система и на каком языке реально ушло сообщение.
      В проде это скорее debug-панель/лог, но здесь наглядно показывает
      автоопределение языка клиента в действии.
    -->
    <div class="channel-note">
      channel: {{ store.result.notification.channel }} · locale: {{ store.result.notification.locale }}
      <br />
      "{{ store.result.notification.renderedText }}"
    </div>

    <button class="primary mt-4" @click="store.reset">↺</button>
  </div>
</template>
