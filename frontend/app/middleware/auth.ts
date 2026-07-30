import { useAuthStore } from "../stores/auth";

export default defineNuxtRouteMiddleware((to) => {
  if (!import.meta.client) return; // токен читаем из localStorage - только на клиенте
  const auth = useAuthStore();
  auth.loadFromStorage();
  if (!auth.isAuthenticated) {
    return navigateTo(`/login?next=${encodeURIComponent(to.fullPath)}`);
  }
});
