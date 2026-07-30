<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useTimioAuthApi, type OwnedBusiness } from "../../composables/useTimioAuthApi";
import { useAuthStore } from "../../stores/auth";

definePageMeta({ middleware: "auth" });

const api = useTimioAuthApi();
const auth = useAuthStore();
const router = useRouter();

const businesses = ref<OwnedBusiness[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");

onMounted(async () => {
  try {
    const res = await api.listBusinesses();
    businesses.value = res.businesses;
    if (businesses.value.length === 0) {
      router.replace("/onboarding");
      return;
    }
    if (businesses.value.length === 1) {
      router.replace(`/app/${businesses.value[0].id}`);
      return;
    }
    status.value = "ready";
  } catch {
    status.value = "error";
  }
});

function logout() {
  auth.logout();
  router.push("/login");
}
</script>

<template>
  <div class="centered-shell">
    <div class="glow" />
    <div v-if="status === 'loading'" class="text-dim">…</div>

    <div v-else-if="status === 'error'" class="auth-card">
      <div class="error-banner">Не удалось загрузить ваши компании. Проверьте соединение с API.</div>
      <button class="btn-secondary" @click="logout">Выйти</button>
    </div>

    <div v-else class="auth-card" style="max-width: 480px">
      <h1 class="page-title">Ваши компании</h1>
      <div v-for="b in businesses" :key="b.id" class="data-row" style="cursor: pointer" @click="router.push(`/app/${b.id}`)">
        <div>
          <div style="font-weight: 700">{{ b.name }}</div>
          <div class="text-dim text-xs">timio.app/{{ b.slug }}</div>
        </div>
        <span class="badge">{{ b.myRole }}</span>
      </div>
      <NuxtLink to="/onboarding" class="btn-secondary mt-4" style="display: block; text-align: center">
        + Добавить компанию
      </NuxtLink>
    </div>
  </div>
</template>
