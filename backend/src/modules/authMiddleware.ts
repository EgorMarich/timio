import type { Context, Next } from "hono";
import { verifyToken } from "./auth.js";

export interface AuthedContext {
  userId: string;
  email: string;
}

// Расширяем через c.set/c.get - Hono типизацию делаем через generic Variables в роутере.
export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const payload = await verifyToken(token);
  if (!payload) return c.json({ error: "invalid_token" }, 401);

  c.set("userId", payload.userId);
  c.set("email", payload.email);
  await next();
}
