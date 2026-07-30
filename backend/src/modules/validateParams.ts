// НОВЫЙ ФАЙЛ
//
// Проблема, которую этот файл решает: если фронтенд по какой-то причине
// вызывает эндпоинт вида /me/businesses/:id/... с :id, буквально равным
// строке "undefined" (типичная причина - компонент читает businessId ДО того,
// как он реально стал доступен, и подставляет его в URL шаблонной строкой),
// Postgres получает попытку распарсить "undefined" как UUID и роняет
// соединение с ошибкой 22P02 ("invalid input syntax for type uuid").
// Без этой защиты такая ошибка не только даёт 500 клиенту, но и засоряет
// логи identичными сообщениями при каждом повторном запросе/поллинге.
//
// Это ЛЁГКАЯ и ТОЧЕЧНАЯ защита - валидирует формат UUID параметров ДО того,
// как они попадут в Drizzle-запрос, и возвращает чистый 400 вместо падения.

import type { Context, Next } from "hono";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string | undefined | null): boolean {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Middleware-фабрика: проверяет, что перечисленные параметры роута (например
 * "id", "staffId", "serviceId") - валидные UUID, иначе сразу отвечает 400
 * и не пропускает запрос дальше к обработчику/БД.
 *
 * Использование: app.use("/me/businesses/:id/*", requireUuidParams("id"))
 */
export function requireUuidParams(...paramNames: string[]) {
  return async (c: Context, next: Next) => {
    for (const name of paramNames) {
      const value = c.req.param(name);
      if (!isValidUuid(value)) {
        return c.json({ error: "invalid_id", message: `Параметр "${name}" должен быть валидным UUID, получено: ${JSON.stringify(value)}` }, 400);
      }
    }
    await next();
  };
}
