import { defineStore } from "pinia";
import type { BookingResult, PublicBusinessPage, Slot } from "../types/booking";

type Step = "service" | "staff" | "date" | "time" | "details" | "done";

// Порядок шагов флоу - используется и для прогресс-бара, и для кнопки "Назад".
const STEP_ORDER: Step[] = ["service", "staff", "date", "time", "details", "done"];

export const useBookingStore = defineStore("booking", {
  state: () => ({
    page: null as PublicBusinessPage | null,
    step: "service" as Step,
    serviceId: null as string | null,
    staffId: null as string | null,
    date: null as string | null,
    slot: null as Slot | null,
    slots: [] as Slot[],
    result: null as BookingResult | null,
    loadingSlots: false,
    submitting: false,
  }),

  getters: {
    selectedService: (state) => state.page?.services.find((s) => s.id === state.serviceId) ?? null,
    selectedStaff: (state) => state.page?.staff.find((s) => s.id === state.staffId) ?? null,
    eligibleStaff: (state) =>
      state.page?.staff.filter((s) => s.serviceIds.includes(state.serviceId ?? "")) ?? [],
    canGoBack: (state) => STEP_ORDER.indexOf(state.step) > 0 && state.step !== "done",
  },

  actions: {
    setPage(page: PublicBusinessPage) {
      this.page = page;
    },
    chooseService(serviceId: string) {
      this.serviceId = serviceId;
      this.step = "staff";
    },
    chooseStaff(staffId: string) {
      this.staffId = staffId;
      this.step = "date";
    },
    chooseDate(date: string) {
      this.date = date;
      this.slot = null;
      this.step = "time";
    },
    chooseSlot(slot: Slot) {
      this.slot = slot;
      this.step = "details";
    },
    goBack() {
      const idx = STEP_ORDER.indexOf(this.step);
      if (idx <= 0) return;
      this.step = STEP_ORDER[idx - 1];
      // При возврате назад чистим выбор ТЕКУЩЕГО (теперь предыдущего) шага,
      // чтобы не остаться с несовместимой комбинацией (например, старый слот
      // времени для другой даты).
      if (this.step === "service") this.staffId = null;
      if (this.step === "staff") this.date = null;
      if (this.step === "date") this.slot = null;
    },
    reset() {
      this.step = "service";
      this.serviceId = null;
      this.staffId = null;
      this.date = null;
      this.slot = null;
      this.result = null;
    },
  },
});
