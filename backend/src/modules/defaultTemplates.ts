// Дефолтные шаблоны уведомлений на 7 языках. Создаются автоматически при
// регистрации нового бизнеса, чтобы у любого владельца "из коробки" работали
// уведомления клиентам, даже если он ничего не настраивал вручную.
// В панели управления (следующий шаг разработки) владелец сможет их отредактировать
// под свой тон общения - но перевод на все 7 языков уже готов заранее.

export const defaultTemplates: Record<string, Record<string, string>> = {
  booking_confirmed: {
    ru: "Здравствуйте, {{clientName}}! Вы записаны на {{time}} к {{staffName}}.",
    en: "Hi {{clientName}}! You're booked for {{time}} with {{staffName}}.",
    es: "¡Hola {{clientName}}! Tu cita es a las {{time}} con {{staffName}}.",
    it: "Ciao {{clientName}}! Il tuo appuntamento è alle {{time}} con {{staffName}}.",
    fr: "Bonjour {{clientName}} ! Votre rendez-vous est à {{time}} avec {{staffName}}.",
    kk: "Сәлем, {{clientName}}! Сіз {{time}} уақытына {{staffName}} маманына жазылдыңыз.",
    hy: "Բարև, {{clientName}}: Դուք գրանցված եք {{time}}-ին {{staffName}}-ի մոտ:",
  },
  reminder: {
    ru: "Напоминаем: у вас запись {{time}} к {{staffName}}.",
    en: "Reminder: your appointment is at {{time}} with {{staffName}}.",
    es: "Recordatorio: tu cita es a las {{time}} con {{staffName}}.",
    it: "Promemoria: il tuo appuntamento è alle {{time}} con {{staffName}}.",
    fr: "Rappel : votre rendez-vous est à {{time}} avec {{staffName}}.",
    kk: "Ескерту: сіздің {{time}} уақытында {{staffName}} маманына жазылуыңыз бар.",
    hy: "Հիշեցում. ձեր այցը {{time}}-ին է՝ {{staffName}}-ի մոտ:",
  },
  thanks_after_visit: {
    ru: "Спасибо за визит, {{clientName}}! Будем рады видеть вас снова.",
    en: "Thanks for your visit, {{clientName}}! We'd love to see you again.",
    es: "¡Gracias por tu visita, {{clientName}}! Nos encantaría verte de nuevo.",
    it: "Grazie per la tua visita, {{clientName}}! Ci farebbe piacere rivederti.",
    fr: "Merci pour votre visite, {{clientName}} ! Nous serions ravis de vous revoir.",
    kk: "Келгеніңізге рахмет, {{clientName}}! Сізді қайта көруге қуаныштымыз.",
    hy: "Շնորհակալություն այցի համար, {{clientName}}: Կուրախանանք նորից տեսնել ձեզ:",
  },
  'waitlist.invite': {
  ru: 'Освободилось место {{start}}–{{end}} для {{service}}. Подтвердите по ссылке: {{link}} (действительно {{ttlMin}} мин).',
  en: 'A spot opened up {{start}}–{{end}} for {{service}}. Confirm here: {{link}} (valid for {{ttlMin}} min).',
  },
  'waitlist.expired': {
    ru: 'Время подтверждения места {{start}}–{{end}} для {{service}} истекло. Вы остаётесь в очереди.',
    en: 'Your confirmation link for {{start}}–{{end}} ({{service}}) has expired. You remain in the waitlist.',
  },
  'waitlist.confirmed': {
    ru: 'Вы подтвердили запись {{start}}–{{end}} на {{service}}. Ждём вас!',
    en: 'You confirmed your appointment {{start}}–{{end}} for {{service}}. See you soon!',
  },
};
