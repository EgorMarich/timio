<script setup lang="ts">
const props = defineProps<{
  businessId: string;
  serviceId: string;
  staffId: string | null;
  startAt: string;
  endAt: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'joined'): void;
}>();

const loading = ref(false);
const success = ref(false);
const error = ref('');

const form = reactive({
  name: '',
  phone: '',
  email: '',
});

async function submit() {
  if (!form.name.trim()) {
    error.value = 'Введите имя';
    return;
  }
  if (!form.phone.trim() && !form.email.trim()) {
    error.value = 'Введите телефон или email — чтобы мы могли вас уведомить';
    return;
  }

  loading.value = true;
  error.value = '';

  try {
    await $fetch('/public/waitlist', {
      method: 'POST',
      body: {
        businessId: props.businessId,
        serviceId: props.serviceId,
        staffId: props.staffId ?? null,
        startAt: props.startAt,
        endAt: props.endAt,
        client: {
          name: form.name.trim(),
          phone: form.phone.trim() || undefined,
          email: form.email.trim() || undefined,
        },
      },
    });

    success.value = true;
    emit('joined');
  } catch (e: any) {
    error.value = e?.data?.error ?? 'Ошибка. Попробуйте ещё раз.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal">

      <!-- Успех -->
      <div v-if="success" class="modal__success">
        <div class="modal__success-icon">🎉</div>
        <h2 class="modal__title">Вы в очереди!</h2>
        <p class="modal__text">
          Как только место освободится — мы сразу отправим вам ссылку для подтверждения.
        </p>
        <button class="modal__btn modal__btn--primary" @click="emit('close')">
          Закрыть
        </button>
      </div>

      <!-- Форма -->
      <template v-else>
        <div class="modal__header">
          <h2 class="modal__title">Записаться в очередь</h2>
          <button class="modal__close" @click="emit('close')">✕</button>
        </div>

        <p class="modal__subtitle">
          Когда место освободится, вы получите уведомление со ссылкой.
          У вас будет 15 минут, чтобы подтвердить запись.
        </p>

        <form class="modal__form" @submit.prevent="submit">
          <label class="modal__label">
            Имя *
            <input
              v-model="form.name"
              type="text"
              class="modal__input"
              placeholder="Ваше имя"
              autocomplete="name"
            />
          </label>

          <label class="modal__label">
            Телефон
            <input
              v-model="form.phone"
              type="tel"
              class="modal__input"
              placeholder="+7 900 000 00 00"
              autocomplete="tel"
            />
          </label>

          <label class="modal__label">
            Email
            <input
              v-model="form.email"
              type="email"
              class="modal__input"
              placeholder="you@example.com"
              autocomplete="email"
            />
          </label>

          <p v-if="error" class="modal__error">{{ error }}</p>

          <button
            type="submit"
            class="modal__btn modal__btn--primary"
            :disabled="loading"
          >
            {{ loading ? 'Отправляем...' : 'Записаться в очередь' }}
          </button>
        </form>
      </template>

    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  padding: 16px;
}

.modal {
  background: #fff;
  border-radius: 16px;
  padding: 32px;
  width: 100%;
  max-width: 440px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
}

.modal__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}

.modal__close {
  background: none;
  border: none;
  font-size: 18px;
  cursor: pointer;
  color: #999;
  padding: 0 0 0 12px;
  line-height: 1;
}

.modal__title {
  font-size: 20px;
  font-weight: 700;
  color: #1a1a1a;
  margin: 0;
}

.modal__subtitle {
  font-size: 14px;
  color: #666;
  line-height: 1.5;
  margin: 0 0 24px;
}

.modal__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal__label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: #333;
}

.modal__input {
  padding: 10px 14px;
  border: 1.5px solid #e0e0e0;
  border-radius: 8px;
  font-size: 15px;
  outline: none;
  transition: border-color 0.15s;
}

.modal__input:focus {
  border-color: #2563eb;
}

.modal__error {
  color: #dc2626;
  font-size: 13px;
  margin: 0;
}

.modal__btn {
  padding: 12px;
  border-radius: 8px;
  border: none;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
  margin-top: 4px;
}

.modal__btn--primary {
  background: #2563eb;
  color: #fff;
}

.modal__btn--primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.modal__btn--primary:disabled {
  background: #93c5fd;
  cursor: not-allowed;
}

.modal__success {
  text-align: center;
  padding: 16px 0;
}

.modal__success-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.modal__text {
  color: #555;
  font-size: 15px;
  line-height: 1.6;
  margin-bottom: 28px;
}
</style>