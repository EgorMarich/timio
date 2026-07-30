export interface BookingUiStrings {
  chooseService: string;
  chooseStaff: string;
  chooseDate?: string;
  chooseTime: string;
  yourName: string;
  yourPhone: string;
  confirmBooking: string;
  bookingConfirmedTitle: string;
  bookingConfirmedBody: string;
  noSlotsToday: string;
  anyStaff: string;
  minutes: string;
}

export interface PublicService {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  currency: string;
  photoUrl?: string | null;
}

export interface PublicStaff {
  id: string;
  name: string;
  serviceIds: string[];
  colorHex: string;
  photoUrl?: string | null;
}

export interface PublicBusinessPage {
  locale: string; // язык КЛИЕНТА, определён бэкендом автоматически
  business: { id: string; name: string; slug: string; timezone: string };
  services: PublicService[];
  staff: PublicStaff[];
  ui: BookingUiStrings;
}

export interface Slot {
  startAt: string;
  endAt: string;
  staffId: string;
}

export interface BookingResult {
  appointment: { id: string; startAt: string; endAt: string };
  clientLocale: string;
  notification: {
    channel: string;
    attempted: string[];
    renderedText: string;
    locale: string;
    status: string;
  };
}
