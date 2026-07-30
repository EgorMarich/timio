<script setup lang="ts">
import { useTheme } from "../composables/useTheme";

const { theme, setTheme } = useTheme();
</script>

<template>
  <div class="theme-toggle">
    <span class="theme-toggle-icon" :class="{ active: theme === 'light' }" @click="setTheme('light')" title="Светлая тема">
      ☀
    </span>
    <span class="theme-toggle-icon" :class="{ active: theme === 'dark' }" @click="setTheme('dark')" title="Тёмная тема">
      ☾
    </span>
  </div>
</template>
