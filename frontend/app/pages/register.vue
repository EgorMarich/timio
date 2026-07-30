<script setup lang="ts">
import { ref } from "vue";
import { useTimioAuthApi } from "../composables/useTimioAuthApi";

const api = useTimioAuthApi();
const router = useRouter();

const name = ref("");
const email = ref("");
const password = ref("");
const loading = ref(false);
const error = ref("");

async function submit() {
  error.value = "";
  if (!name.value || !email.value || password.value.length < 8) {
    error.value = "Заполните имя, email и пароль (минимум 8 символов).";
    return;
  }
  loading.value = true;
  try {
    await api.register({ name: name.value, email: email.value, password: password.value });
    router.push("/onboarding");
  } catch (e: any) {
    error.value = e.message === "email_taken" ? "Этот email уже зарегистрирован." : "Не удалось зарегистрироваться. Проверьте соединение с API.";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="centered-shell">
    <div class="glow" />
    <div class="auth-card">
      <div class="brand">
        <span class="brand-mark">T</span>
        <span class="brand-name">Timio</span>
      </div>

      <h1 class="page-title">Создать аккаунт</h1>
      <p class="page-subtitle">Заведите свою компанию и начните принимать записи за пару минут.</p>

      <div v-if="error" class="error-banner">{{ error }}</div>

      <form @submit.prevent="submit">
        <div class="field">
          <label class="field-label">Ваше имя</label>
          <input v-model="name" type="text" placeholder="Мария Петрова" autocomplete="name" />
        </div>
        <div class="field">
          <label class="field-label">Email</label>
          <input v-model="email" type="email" placeholder="you@example.com" autocomplete="email" />
        </div>
        <div class="field">
          <label class="field-label">Пароль</label>
          <input v-model="password" type="password" placeholder="Минимум 8 символов" autocomplete="new-password" />
        </div>
        <button class="btn-primary" type="submit" :disabled="loading">
          {{ loading ? "…" : "Зарегистрироваться" }}
        </button>
      </form>

      <p class="footer-link">
        Уже есть аккаунт?
        <NuxtLink to="/login" class="btn-link">Войти</NuxtLink>
      </p>
    </div>
  </div>
</template>
