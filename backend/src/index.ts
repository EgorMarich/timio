import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { publicRoutes } from "./modules/public.routes.js";
import { authRoutes } from "./modules/auth.routes.js";
import { meRoutes } from "./modules/me.routes.js";
// Модуль подписок и оплаты (ЮKassa) - дописан, существующие роуты выше не менялись.
import { subscriptionRoutes } from "./modules/subscriptions/subscription.routes.js";
import { promoCodeRoutes } from "./modules/subscriptions/promoCode.routes.js";
import { yookassaWebhookRoutes } from "./modules/subscriptions/webhook.routes.js";
import { startSubscriptionCron } from "./modules/subscriptions/subscriptionCron.js";
// Модуль реальной отправки уведомлений в Telegram - дописан, существующие роуты выше не менялись.
import { telegramWebhookRoutes, telegramSettingsRoutes } from "./modules/telegram/telegram.routes.js";
import { startReminderWorker } from "./modules/notifications/reminderWorker.js";
// Защита от "invalid syntax for uuid: undefined" - см. подробный комментарий в файле.
import { requireUuidParams } from "./modules/validateParams.js";
import { startWaitlistWorker } from './modules/waitlist/waitlistWorker.js'

const app = new Hono<{ Variables: { userId: string; email: string } }>();

app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", "Content-Type, Accept-Language, Authorization");
  c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

// Валидируем :id (businessId) ДО того, как запрос дойдёт до любого /me/businesses/:id/*
// обработчика - если фронт по ошибке передал "undefined"/пустую строку/не-UUID,
// клиент получит чистый 400 вместо падения Postgres-соединения с сырой ошибкой.
app.use("/me/businesses/:id/*", requireUuidParams("id"));
app.use("/me/businesses/:id", requireUuidParams("id"));

app.get("/", (c) => c.json({ name: "Timio API", status: "ok" }));

// /auth - регистрация/вход владельца бизнеса
app.route("/auth", authRoutes);
// /me - всё, что владелец делает СО СВОИМ бизнесом (создание компании, услуги, сотрудники, записи) - требует JWT
app.route("/me", meRoutes);
// Роуты подписки/биллинга - тот же префикс /me, т.к. это тоже действия владельца
// над СВОИМ бизнесом (см. subscription.routes.ts: пути вида /me/businesses/:id/subscription/*).
app.route("/me", subscriptionRoutes);
app.route("/me", promoCodeRoutes);
// Настройки Telegram-бота бизнеса - тот же принцип "/me/businesses/:id/..." (требует JWT)
app.route("/me", telegramSettingsRoutes);
// /public - то, чем пользуется клиент на публичной странице записи (без авторизации)
app.route("/public", publicRoutes);
// /webhooks/yookassa - публичный эндпоинт для колбэков от ЮKassa, без requireAuth
// (подлинность платежа проверяется повторным запросом к API ЮKassa, см. webhook.routes.ts)
app.route("/webhooks", yookassaWebhookRoutes);
// /webhooks/telegram/:businessId - публичный эндпоинт, куда Telegram шлёт входящие
// сообщения (в частности - /start от клиента при подключении уведомлений)
app.route("/webhooks", telegramWebhookRoutes);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Timio API listening on http://localhost:${info.port}`);
});

// Фоновая проверка окончания триалов и продления подписок (см. subscriptionCron.ts).
startSubscriptionCron();
// Фоновая обработка очереди напоминаний о записи (см. reminderWorker.ts) -
// без этого напоминания складывались в Redis, но никогда не отправлялись.
startReminderWorker();
startWaitlistWorker();
