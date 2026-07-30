import * as XLSX from "xlsx";
import type { AnalyticsResponse } from "../composables/useTimioAuthApi";

function money(cents: number) {
  return Math.round(cents) / 100;
}

/** Собирает многолистовой .xlsx отчёт из данных аналитики и скачивает его в браузере. */
export function downloadAnalyticsXlsx(businessName: string, data: AnalyticsResponse) {
  const wb = XLSX.utils.book_new();

  const summarySheet = XLSX.utils.aoa_to_sheet([
    ["Отчёт по бизнесу", businessName],
    ["Сформирован", new Date().toLocaleString("ru-RU")],
    [],
    ["Показатель", "Значение"],
    ["Выручка", money(data.summary.totalRevenueCents)],
    ["Налог (%)", data.summary.taxPercent],
    ["Сумма налога", money(data.summary.taxCents)],
    ["Комиссии сотрудников", money(data.summary.totalCommissionCents)],
    ["Чистая прибыль", money(data.summary.netProfitCents)],
    ["Всего записей", data.summary.totalAppointments],
    ["Клиентов", data.summary.totalClients],
    ["Средний чек", money(data.summary.avgCheckCents)],
    ["Неявок (no-show)", data.summary.noShowCount],
    ["Отменено", data.summary.cancelledCount],
  ]);
  XLSX.utils.book_append_sheet(wb, summarySheet, "Сводка");

  const byDaySheet = XLSX.utils.json_to_sheet(
    data.byDay.map((d) => ({ Дата: d.date, Выручка: money(d.revenueCents), Записей: d.appointments }))
  );
  XLSX.utils.book_append_sheet(wb, byDaySheet, "По дням");

  const byServiceSheet = XLSX.utils.json_to_sheet(
    data.byService.map((s) => ({ Услуга: s.name, Выручка: money(s.revenueCents), Записей: s.count }))
  );
  XLSX.utils.book_append_sheet(wb, byServiceSheet, "По услугам");

  const byStaffSheet = XLSX.utils.json_to_sheet(
    data.byStaff.map((s) => ({
      Сотрудник: s.name,
      Выручка: money(s.revenueCents),
      Комиссия: money(s.commissionCents),
      Записей: s.count,
    }))
  );
  XLSX.utils.book_append_sheet(wb, byStaffSheet, "По сотрудникам");

  const rowsSheet = XLSX.utils.json_to_sheet(
    data.rows.map((r) => ({
      Дата: r.date,
      Клиент: r.client,
      Услуга: r.service,
      Сотрудник: r.staff,
      Статус: r.status,
      Сумма: money(r.priceCents),
      Комиссия: money(r.commissionCents),
      Валюта: r.currency,
    }))
  );
  XLSX.utils.book_append_sheet(wb, rowsSheet, "Все записи");

  const fileName = `${businessName.replace(/[^\p{L}\p{N}]+/gu, "_")}_report_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fileName);
}
