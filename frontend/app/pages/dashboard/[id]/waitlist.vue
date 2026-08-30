<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

type WaitlistStatus = 'active' | 'invited' | 'claimed' | 'expired' | 'cancelled';

type WaitlistEntry = {
  id: string;
  clientName: string;
  serviceName: string;
  staffName: string;
  staffId: string | null;
  startAt: string;
  endAt: string;
  status: WaitlistStatus;
  priority: number;
  inviteSentAt: string | null;
  holdExpiresAt: string | null;
  createdAt: string;
};

const route = useRoute();
const businessId = route.params.id as string;

const rows = ref<WaitlistEntry[]>([]);
const loading = ref(false);
const error = ref('');
const filterStatus = ref<WaitlistStatus | ''>('');
const actionLoading = ref<string | null>(null);

const statusLabels: Record<WaitlistStatus, string> = {
  active: 'Ожидает',
  invited: 'Приглашён',
  claimed: 'Подтверждён',
  expired: 'Истёк',
  cancelled: 'Отменён',
};

const statusColors: Record<WaitlistStatus, string> = {
  active: '#2563eb',
  invited: '#f59e0b',
  claimed: '#16a34a',
  expired: '#9ca3af',
  cancelled: '#ef4444',
};

const counts = computed(() => ({
  active: rows.value.filter((r) => r.status === 'active').length,
  invited: rows.value.filter((r) => r.status === 'invited').length,
  claimed: rows.value.filter((r) => r.status === 'claimed').length,
}));

const filteredRows = computed(() =>
  filterStatus.value
    ? rows.value.filter((r) => r.status === filterStatus.value)
    : rows.value,
);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const query = filterStatus.value ? `?status=${filterStatus.value}` : '';
    const data = await $fetch<{ waitlist: WaitlistEntry[] }>(
      `/me/businesses/${businessId}/waitlist${query}`,
    );
    rows.value = data.waitlist ?? [];
  } catch (e: any) {
    error.value = e?.data?.error ?? 'Ошибка загрузки';
  } finally {
    loading.value = false;
  }
}

async function cancelEntry(id: string) {
  if (!confirm('Отменить заявку?')) return;
  actionLoading.value = id;
  try {
    await $fetch(`/me/businesses/${businessId}/waitlist/${id}`, {
      method: 'PATCH',
      body: { status: 'cancelled' },
    });
    await load();
  } finally {
    actionLoading.value = null;
  }
}

async function forceInvite(id: string) {
  if (!confirm('Отправить приглашение сейчас?')) return;
  actionLoading.value = id;
  try {
    await $fetch(`/me/businesses/${businessId}/waitlist/${id}/notify`, {
      method: 'POST',
    });
    await load();
  } catch (e: any) {
    alert(e?.data?.error ?? 'Ошибка');
  } finally {
    actionLoading.value = null;
  }
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function holdTimeLeft(holdExpiresAt: string | null) {
  if (!holdExpiresAt) return null;
  const ms = new Date(holdExpiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}м ${sec}с`;
}

await load();
</script>

<template>
  <div class="wl">

    <div class="wl__header">
      <h1 class="wl__title">Очередь ожидания</h1>
      <button class="wl__refresh" :disabled="loading" @click="load">
        {{ loading ? 'Загрузка...' : '↻ Обновить' }}
      </button>
    </div>

    <!-- Счётчики -->
    <div class="wl__stats">
      <div class="wl__stat">
        <span class="wl__stat-num">{{ counts.active }}</span>
        <span class="wl__stat-label">Ожидают</span>
      </div>
      <div class="wl__stat">
        <span class="wl__stat-num" style="color: #f59e0b">{{ counts.invited }}</span>
        <span class="wl__stat-label">Приглашены</span>
      </div>
      <div class="wl__stat">
        <span class="wl__stat-num" style="color: #16a34a">{{ counts.claimed }}</span>
        <span class="wl__stat-label">Подтверждены</span>
      </div>
    </div>

    <!-- Фильтры -->
    <div class="wl__filters">
      <button
        v-for="s in ['', 'active', 'invited', 'claimed', 'expired', 'cancelled']"
        :key="s"
        class="wl__filter-btn"
        :class="{ 'wl__filter-btn--active': filterStatus === s }"
        @click="filterStatus = s as WaitlistStatus | ''; load()"
      >
        {{ s === '' ? 'Все' : statusLabels[s as WaitlistStatus] }}
      </button>
    </div>

    <p v-if="error" class="wl__error">{{ error }}</p>

    <!-- Таблица -->
    <div class="wl__table-wrap">
      <table v-if="filteredRows.length" class="wl__table">
        <thead>
          <tr>
            <th>Клиент</th>
            <th>Услуга</th>
            <th>Сотрудник</th>
            <th>Слот</th>
            <th>Статус</th>
            <th>Холд истекает</th>
            <th>В очереди с</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in filteredRows" :key="entry.id">
            <td class="wl__td--bold">{{ entry.clientName }}</td>
            <td>{{ entry.serviceName }}</td>
            <td>{{ entry.staffName }}</td>
            <td class="wl__td--nowrap">
              {{ fmtDate(entry.startAt) }} – {{ fmtDate(entry.endAt) }}
            </td>
            <td>
              <span
                class="wl__badge"
                :style="{ background: statusColors[entry.status] }"
              >
                {{ statusLabels[entry.status] }}
              </span>
            </td>
            <td>
              <span
                v-if="entry.status === 'invited' && entry.holdExpiresAt"
                class="wl__hold-timer"
              >
                ⏱ {{ holdTimeLeft(entry.holdExpiresAt) ?? 'Истёк' }}
              </span>
              <span v-else>—</span>
            </td>
            <td>{{ fmtDate(entry.createdAt) }}</td>
            <td class="wl__actions">
              <button
                v-if="entry.status === 'active'"
                class="wl__btn wl__btn--invite"
                :disabled="actionLoading === entry.id"
                @click="forceInvite(entry.id)"
              >
                Пригласить
              </button>
              <button
                v-if="entry.status === 'active' || entry.status === 'invited'"
                class="wl__btn wl__btn--cancel"
                :disabled="actionLoading === entry.id"
                @click="cancelEntry(entry.id)"
              >
                Отменить
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else class="wl__empty">
        Очередь пуста{{ filterStatus ? ' по выбранному фильтру' : '' }}
      </div>
    </div>

  </div>
</template>

<style scoped>
.wl {
  padding: 32px;
  max-width: 1100px;
}

.wl__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.wl__title {
  font-size: 24px;
  font-weight: 700;
  margin: 0;
}

.wl__refresh {
  padding: 8px 16px;
  border-radius: 8px;
  border: 1.5px solid #e0e0e0;
  background: #fff;
  font-size: 14px;
  cursor: pointer;
}

.wl__stats {
  display: flex;
  gap: 16px;
  margin-bottom: 24px;
}

.wl__stat {
  background: #fff;
  border: 1.5px solid #e0e0e0;
  border-radius: 12px;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 110px;
}

.wl__stat-num {
  font-size: 28px;
  font-weight: 700;
  color: #2563eb;
}

.wl__stat-label {
  font-size: 13px;
  color: #888;
}

.wl__filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.wl__filter-btn {
  padding: 6px 14px;
  border-radius: 20px;
  border: 1.5px solid #e0e0e0;
  background: #fff;
  font-size: 13px;
  color: #555;
  cursor: pointer;
  transition: all 0.15s;
}

.wl__filter-btn--active {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}

.wl__error {
  color: #dc2626;
  margin-bottom: 16px;
}

.wl__table-wrap {
  overflow-x: auto;
}

.wl__table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}

.wl__table th {
  background: #f8fafc;
  padding: 12px 16px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1.5px solid #f0f0f0;
}

.wl__table td {
  padding: 14px 16px;
  font-size: 14px;
  color: #333;
  border-bottom: 1px solid #f5f5f5;
  vertical-align: middle;
}

.wl__table tr:last-child td {
  border-bottom: none;
}

.wl__td--bold {
  font-weight: 600;
}

.wl__td--nowrap {
  white-space: nowrap;
  font-size: 13px;
}

.wl__badge {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
}

.wl__hold-timer {
  font-size: 13px;
  font-weight: 600;
  color: #f59e0b;
}

.wl__actions {
  display: flex;
  gap: 8px;
}

.wl__btn {
  padding: 6px 12px;
  border-radius: 6px;
  border: none;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.wl__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wl__btn--invite {
  background: #eff6ff;
  color: #2563eb;
}

.wl__btn--invite:hover:not(:disabled) {
  background: #dbeafe;
}

.wl__btn--cancel {
  background: #fef2f2;
  color: #dc2626;
}

.wl__btn--cancel:hover:not(:disabled) {
  background: #fee2e2;
}

.wl__empty {
  text-align: center;
  padding: 48px;
  color: #999;
  font-size: 15px;
  background: #fff;
  border-radius: 12px;
}
</style>