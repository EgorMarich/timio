import { defineStore } from "pinia";

interface OwnerUser {
  id: string;
  email: string;
  name: string;
  locale: string;
}

export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: null as string | null,
    user: null as OwnerUser | null,
  }),

  actions: {
    setSession(token: string, user: OwnerUser) {
      this.token = token;
      this.user = user;
      if (import.meta.client) {
        localStorage.setItem("timio_token", token);
      }
    },
    loadFromStorage() {
      if (import.meta.client) {
        const token = localStorage.getItem("timio_token");
        if (token) this.token = token;
      }
    },
    logout() {
      this.token = null;
      this.user = null;
      if (import.meta.client) {
        localStorage.removeItem("timio_token");
      }
    },
  },

  getters: {
    isAuthenticated: (state) => Boolean(state.token),
  },
});
