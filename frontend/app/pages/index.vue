<script setup lang="ts">
import { onMounted } from "vue";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const router = useRouter();

onMounted(() => {
  auth.loadFromStorage();
  if (auth.isAuthenticated) {
    router.replace("/app");
  }
});
</script>

<template>
  <div class="centered-shell">
    <div class="glow" />
    <div class="auth-card" style="max-width: 460px; text-align: center">
      <div class="brand" style="justify-content: center">
        <span class="brand-mark">T</span>
        <span class="brand-name">Timio</span>
      </div>

      <h1 class="page-title">Онлайн-запись для вашего бизнеса</h1>
      <p class="page-subtitle">
        Календарь, CRM и автоматические уведомления клиентам на их родном языке —
        даже если вы сами говорите на другом.
      </p>

      <div style="display: flex; flex-direction: column; gap: 10px">
        <NuxtLink to="/register" class="btn-primary" style="display: block; text-decoration: none">
          Создать компанию бесплатно
        </NuxtLink>
        <NuxtLink to="/login" class="btn-secondary" style="display: block; text-decoration: none">
          У меня уже есть аккаунт
        </NuxtLink>
      </div>

      <p class="footer-link text-xs">
        Хотите просто посмотреть демо? Войдите как <code class="mono">demo@timio.app</code> / <code class="mono">demo12345</code>
      </p>
    </div>
  </div>
</template>
