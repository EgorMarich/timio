<script setup lang="ts">
const route = useRoute();

const status = computed(() => route.query.status as string);
const reason = computed(() => route.query.reason as string);

const isOk = computed(() => status.value === 'ok');

const reasonText: Record<string, string> = {
  expired:
    'К сожалению, время подтверждения истекло. Вы по-прежнему в очереди и получите новое приглашение, если место освободится снова.',
  already_taken:
    'Это место уже занято. Мы пригласим вас, когда освободится следующее.',
  invalid_or_not_invited:
    'Ссылка недействительна или уже была использована.',
};

const errorMessage = computed(
  () => reasonText[reason.value] ?? 'Что-то пошло не так. Попробуйте ещё раз.',
);
</script>

<template>
  <div class="claim-result">

    <div
      class="claim-result__card"
      :class="isOk ? 'claim-result__card--success' : 'claim-result__card--error'"
    >
      <div class="claim-result__icon">
        <template v-if="isOk">✅</template>
        <template v-else-if="reason === 'expired' || reason === 'already_taken'">⏳</template>
        <template v-else>❌</template>
      </div>

      <h1 class="claim-result__title">
        <template v-if="isOk">Запись подтверждена!</template>
        <template v-else-if="reason === 'expired'">Время вышло</template>
        <template v-else>Место недоступно</template>
      </h1>

      <p class="claim-result__text">
        <template v-if="isOk">
          Мы ждём вас. Детали записи были отправлены вам в уведомлении.
        </template>
        <template v-else>{{ errorMessage }}</template>
      </p>

      <button class="claim-result__btn" @click="navigateTo('/')">
        На главную
      </button>
    </div>

  </div>
</template>

<style scoped>
.claim-result {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #f5f5f5;
}

.claim-result__card {
  max-width: 480px;
  width: 100%;
  background: #fff;
  border-radius: 16px;
  padding: 48px 32px;
  text-align: center;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
}

.claim-result__icon {
  font-size: 56px;
  margin-bottom: 16px;
}

.claim-result__title {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 12px;
  color: #1a1a1a;
}

.claim-result__text {
  font-size: 15px;
  color: #555;
  line-height: 1.6;
  margin-bottom: 32px;
}

.claim-result__btn {
  padding: 12px 32px;
  border-radius: 8px;
  border: none;
  background: #2563eb;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.claim-result__btn:hover {
  background: #1d4ed8;
}
</style>