import type { SupportedLocale } from "../types.js";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "../types.js";

/**
 * Автоопределение языка КЛИЕНТА.
 *
 * Ключевое правило продукта: владелец бизнеса НЕ выбирает, на каких языках
 * говорить с клиентами. Публичная страница записи и все уведомления
 * (Telegram/WhatsApp/SMS/Email) всегда подстраиваются под язык самого клиента.
 * Благодаря этому английский клиент может забронировать услугу у русского
 * бизнеса, даже если хозяин ни разу не открывал настройки языка.
 *
 * Источники языка клиента (в порядке приоритета):
 *  1. Явно сохранённый detectedLocale в карточке клиента (если клиент уже бронировал раньше)
 *  2. Telegram language_code (если бронирование пришло через Telegram-бота)
 *  3. Заголовок Accept-Language браузера (публичный виджет записи)
 *  4. DEFAULT_LOCALE ("en") как последний fallback
 */

export function parseAcceptLanguage(header: string | null | undefined): SupportedLocale {
  if (!header) return DEFAULT_LOCALE;

  // "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7" -> [["ru-RU",1],["ru",0.9],["en-US",0.8],["en",0.7]]
  const parsed = header
    .split(",")
    .map((part) => {
      const [rawTag, rawQ] = part.trim().split(";q=");
      const q = rawQ ? parseFloat(rawQ) : 1;
      return { tag: rawTag.trim().toLowerCase(), q: Number.isNaN(q) ? 1 : q };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of parsed) {
    const base = tag.split("-")[0] as SupportedLocale;
    if (SUPPORTED_LOCALES.includes(base)) return base;
  }
  return DEFAULT_LOCALE;
}

export function fromTelegramLanguageCode(code: string | undefined): SupportedLocale | null {
  if (!code) return null;
  const base = code.split("-")[0].toLowerCase() as SupportedLocale;
  return SUPPORTED_LOCALES.includes(base) ? base : null;
}

/**
 * Итоговая функция резолва языка для нового обращения клиента.
 * savedLocale - если у клиента уже есть карточка в CRM, его сохранённый язык
 * имеет приоритет (даже если сейчас он открыл страницу с другого устройства/языка браузера) -
 * так его переписка остаётся консистентной на одном языке.
 */
export function resolveClientLocale(input: {
  savedLocale?: SupportedLocale;
  telegramLanguageCode?: string;
  acceptLanguageHeader?: string | null;
}): SupportedLocale {
  if (input.savedLocale) return input.savedLocale;

  const fromTelegram = fromTelegramLanguageCode(input.telegramLanguageCode);
  if (fromTelegram) return fromTelegram;

  return parseAcceptLanguage(input.acceptLanguageHeader);
}
