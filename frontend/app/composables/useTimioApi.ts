import type { BookingResult, PublicBusinessPage, Slot } from "../types/booking";

export function useTimioApi() {
  const config = useRuntimeConfig();
  const base = config.public.apiBase;

  // Важно: явных заголовков Accept-Language не передаём вручную -
  // браузер сам прикладывает свой при обычном fetch с клиента,
  // и именно по нему бэкенд определяет язык клиента (см. resolveClientLocale).
  async function fetchBusinessPage(slug: string): Promise<PublicBusinessPage> {
    return await $fetch<PublicBusinessPage>(`${base}/public/${slug}`);
  }

  async function fetchAvailability(params: {
    slug: string;
    serviceId: string;
    date: string;
    staffId?: string;
  }): Promise<Slot[]> {
    const { slots } = await $fetch<{ slots: Slot[] }>(`${base}/public/${params.slug}/availability`, {
      query: { serviceId: params.serviceId, date: params.date, staffId: params.staffId },
    });
    return slots;
  }

  async function submitBooking(params: {
    slug: string;
    serviceId: string;
    staffId: string;
    startAt: string;
    clientName: string;
    clientPhone: string;
  }): Promise<BookingResult> {
    return await $fetch<BookingResult>(`${base}/public/${params.slug}/book`, {
      method: "POST",
      body: params,
    });
  }

  return { apiBase: base, fetchBusinessPage, fetchAvailability, submitBooking };
}
