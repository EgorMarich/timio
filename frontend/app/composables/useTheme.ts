import { ref, watchEffect } from "vue";

const theme = ref<"light" | "dark">("light");
let initialized = false;

export function useTheme() {
  if (!initialized && import.meta.client) {
    initialized = true;
    const saved = localStorage.getItem("timio_theme");
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    theme.value = (saved as "light" | "dark") ?? (prefersDark ? "dark" : "light");

    watchEffect(() => {
      document.documentElement.setAttribute("data-theme", theme.value);
      localStorage.setItem("timio_theme", theme.value);
    });
  }

  function setTheme(value: "light" | "dark") {
    theme.value = value;
  }
  function toggle() {
    theme.value = theme.value === "light" ? "dark" : "light";
  }

  return { theme, setTheme, toggle };
}
