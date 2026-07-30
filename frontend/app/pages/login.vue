<script setup lang="ts">
import { ref } from "vue";
import { useTimioAuthApi } from "../composables/useTimioAuthApi";

const api = useTimioAuthApi();
const router = useRouter();
const route = useRoute();

const email = ref("");
const password = ref("");
const loading = ref(false);
const error = ref("");

async function submit() {
  error.value = "";
  if (!email.value || !password.value) {
    error.value = "Введите email и пароль.";
    return;
  }
  loading.value = true;
  try {
    await api.login({ email: email.value, password: password.value });
    const next = (route.query.next as string) || "/app";
    router.push(next);
  } catch {
    error.value = "Неверный email или пароль.";
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

      <h1 class="page-title">Вход</h1>
      <p class="page-subtitle">Войдите, чтобы управлять расписанием и клиентами.</p>

      <div v-if="error" class="error-banner">{{ error }}</div>

      <form @submit.prevent="submit">
        <div class="field">
          <label class="field-label">Email</label>
          <input v-model="email" type="email" placeholder="you@example.com" autocomplete="email" />
        </div>
        <div class="field">
          <label class="field-label">Пароль</label>
          <input v-model="password" type="password" placeholder="••••••••" autocomplete="current-password" />
        </div>
        <button class="btn-primary" type="submit" :disabled="loading">
          {{ loading ? "…" : "Войти" }}
        </button>
      </form>

      <p class="footer-link">
        Нет аккаунта?
        <NuxtLink to="/register" class="btn-link">Зарегистрироваться</NuxtLink>
      </p>
      <p class="footer-link text-xs">Демо-доступ: demo@timio.app / demo12345</p>
    </div>
  </div>
</template>
