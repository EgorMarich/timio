import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  pgEnum,
  uuid,
  varchar,
  boolean,
} from "drizzle-orm/pg-core";

// Схема соответствует разделу 11 продуктовой спецификации (business/services/
// staff/clients/appointments/message_templates), только вместо MongoDB - Postgres.
// Мультиязычные поля (название услуги, шаблоны сообщений) хранятся как jsonb
// вида { "ru": "...", "en": "...", ... } - гибкость документа сохраняется,
// но данные лежат в реляционной БД с транзакциями и внешними ключами.

export const notificationChannelEnum = pgEnum("notification_channel", [
  "telegram",
  "whatsapp",
  "viber",
  "messenger",
  "sms",
  "email",
]);

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "booked",
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
]);

export const userRoleEnum = pgEnum("user_role", ["owner", "administrator", "manager", "employee"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  // язык ВЛАДЕЛЬЦА в ЕГО панели управления - не влияет на язык клиентов
  locale: varchar("locale", { length: 5 }).notNull().default("en"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  name: text("name").notNull(),
  niche: varchar("niche", { length: 60 }).notNull(),
  timezone: varchar("timezone", { length: 60 }).notNull(),
  channelPriority: jsonb("channel_priority").$type<string[]>().notNull(),
  workingHours: jsonb("working_hours").$type<Record<number, { start: number; end: number } | null>>().notNull(),
  // Ставка налога в процентах (0-100, с сотыми долями), применяется к выручке
  // при расчёте чистой прибыли в аналитике. Хранится как integer в сотых долях
  // процента (2050 = 20.50%), чтобы избежать проблем с плавающей точкой.
  taxPercentBp: integer("tax_percent_bp").notNull().default(0),
  // Telegram-бот бизнеса для реальной отправки уведомлений клиентам (см. modules/telegram/).
  // Владелец создаёт бота через @BotFather и вставляет токен в настройках.
  // ВАЖНО: в проде токен должен храниться зашифрованным, а не открытым текстом -
  // здесь оставлено как есть для скорости MVP (см. TODO в telegram.service.ts).
  telegramBotToken: text("telegram_bot_token"),
  telegramBotUsername: varchar("telegram_bot_username", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const businessMembers = pgTable("business_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: userRoleEnum("role").notNull().default("employee"),
});

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: jsonb("name").$type<Record<string, string>>().notNull(), // мультиязычное название
  durationMin: integer("duration_min").notNull(),
  priceCents: integer("price_cents").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  // Фото услуги. В MVP храним как data-URL (base64) прямо в БД - без отдельного
  // объектного хранилища; в проде это заменяется на ссылку на S3/CDN.
  photoUrl: text("photo_url"),
});

export const staff = pgTable("staff", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  serviceIds: jsonb("service_ids").$type<string[]>().notNull(),
  workingHours: jsonb("working_hours").$type<Record<number, { start: number; end: number } | null> | null>(),
  colorHex: varchar("color_hex", { length: 7 }).notNull(),
  photoUrl: text("photo_url"),
  // Процент, который сотрудник получает с каждой оказанной услуги (0-100, сотые
  // доли, integer basis points: 4500 = 45.00%). Используется в аналитике для
  // расчёта чистой прибыли владельца = выручка - налог - комиссии сотрудников.
  commissionPercentBp: integer("commission_percent_bp").notNull().default(0),
});

export const clients = pgTable("clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  phone: varchar("phone", { length: 32 }),
  email: varchar("email", { length: 255 }),
  telegramChatId: varchar("telegram_chat_id", { length: 64 }),
  // Язык клиента определяется автоматически при первом обращении и дальше
  // не меняется молча - см. resolveClientLocale(). Владелец бизнеса это поле не редактирует.
  detectedLocale: varchar("detected_locale", { length: 5 }).notNull(),
  preferredChannel: notificationChannelEnum("preferred_channel"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  notes: jsonb("notes").$type<string[]>().notNull().default([]),
  totalSpentCents: integer("total_spent_cents").notNull().default(0),
  visits: integer("visits").notNull().default(0),
  lastVisitAt: timestamp("last_visit_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const appointments = pgTable("appointments", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  staffId: uuid("staff_id").notNull().references(() => staff.id, { onDelete: "cascade" }),
  serviceId: uuid("service_id").notNull().references(() => services.id, { onDelete: "cascade" }),
  startAt: timestamp("start_at").notNull(),
  endAt: timestamp("end_at").notNull(),
  status: appointmentStatusEnum("status").notNull().default("booked"),
  source: varchar("source", { length: 30 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const messageTemplates = pgTable("message_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 40 }).notNull(),
  // { "ru": "...", "en": "...", "es": "...", ... }
  translations: jsonb("translations").$type<Record<string, string>>().notNull(),
});

export const notificationLogs = pgTable("notification_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  channel: notificationChannelEnum("channel").notNull(),
  attemptedChannels: jsonb("attempted_channels").$type<string[]>().notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  renderedText: text("rendered_text").notNull(),
  locale: varchar("locale", { length: 5 }).notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});

export const businessNotificationSettings = pgTable(
  "business_notification_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, {
        onDelete: "cascade",
      }),

    event: varchar("event", {
      length: 50,
    }).notNull(),

    enabledChannels: jsonb("enabled_channels")
      .$type<string[]>()
      .notNull()
      .default([]),

    enabled: boolean("enabled")
      .notNull()
      .default(true),

    createdAt: timestamp("created_at")
      .defaultNow()
      .notNull(),
  },
);

// ================================================================
// Модуль подписок и оплаты (ЮKassa). Дописано поверх существующей
// схемы - таблицы выше не менялись.
// ================================================================

export const subscriptionPlanEnum = pgEnum("subscription_plan", ["basic", "business"]);

// trial -> active -> expired / cancelled. Подробная машина состояний и переходы
// между ними - в modules/subscriptions/subscription.service.ts.
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trial",
  "active",
  "expired",
  "cancelled",
]);

export const promoDiscountTypeEnum = pgEnum("promo_discount_type", ["percent", "fixed"]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "succeeded",
  "canceled",
  "failed",
]);

// Ровно ОДНА подписка на бизнес (действующая история переходов состояний
// хранится в payments, а не отдельными строками подписки).
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id")
    .notNull()
    .unique()
    .references(() => businesses.id, { onDelete: "cascade" }),
  plan: subscriptionPlanEnum("plan").notNull(),
  status: subscriptionStatusEnum("status").notNull().default("trial"),
  trialEndsAt: timestamp("trial_ends_at").notNull(),
  // Конец уже ОПЛАЧЕННОГO периода (для active) - когда cron должен попытаться
  // списать следующий платёж.
  currentPeriodEndsAt: timestamp("current_period_ends_at"),
  // ID сохранённого способа оплаты в ЮKassa (payment_method_id), полученный
  // при привязке карты во время триала. Без него рекуррентное списание невозможно.
  yookassaPaymentMethodId: text("yookassa_payment_method_id"),
  // Промокод, применённый к ПЕРВОМУ месяцу оплаты (см. promo_code_redemptions
  // для истории/защиты от повторного использования).
  appliedPromoCodeId: uuid("applied_promo_code_id").references(() => promoCodes.id),
  cancelledAt: timestamp("cancelled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const promoCodes = pgTable("promo_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  discountType: promoDiscountTypeEnum("discount_type").notNull(),
  // Для percent: 0-100 (целое, %). Для fixed: сумма скидки в центах/копейках.
  discountValue: integer("discount_value").notNull(),
  maxUses: integer("max_uses"), // null = без ограничения по количеству использований
  usedCount: integer("used_count").notNull().default(0),
  expiresAt: timestamp("expires_at"), // null = бессрочный
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Факт использования промокода конкретным бизнесом - защищает от повторного
// применения одного и того же кода одним и тем же бизнесом.
export const promoCodeRedemptions = pgTable("promo_code_redemptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  promoCodeId: uuid("promo_code_id").notNull().references(() => promoCodes.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  redeemedAt: timestamp("redeemed_at").defaultNow().notNull(),
});

// Журнал всех платежей/попыток списания ЮKassa - и привязки карты (сумма может
// быть символической), и обычных рекуррентных списаний.
export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  yookassaPaymentId: varchar("yookassa_payment_id", { length: 64 }).notNull().unique(),
  amountCents: integer("amount_cents").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("RUB"),
  status: paymentStatusEnum("status").notNull().default("pending"),
  // "card_binding" - символическое списание при активации триала для сохранения
  // способа оплаты; "recurring" - обычное автосписание по расписанию.
  purpose: varchar("purpose", { length: 20 }).notNull(),
  idempotenceKey: varchar("idempotence_key", { length: 64 }).notNull(),
  rawPayload: jsonb("raw_payload"), // сырой ответ ЮKassa - на случай разбора инцидентов
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
