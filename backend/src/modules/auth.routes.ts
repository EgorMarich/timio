import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword, signToken } from "./auth.js";

export const authRoutes = new Hono();

authRoutes.post("/register", async (c) => {
  const body = await c.req.json<{ email: string; password: string; name: string; locale?: string }>();

  if (!body.email || !body.password || body.password.length < 8 || !body.name) {
    return c.json({ error: "invalid_input", message: "Email, name and password (8+ chars) are required" }, 400);
  }

  const existing = await db.select().from(users).where(eq(users.email, body.email.toLowerCase()));
  if (existing.length > 0) {
    return c.json({ error: "email_taken" }, 409);
  }

  const [user] = await db
    .insert(users)
    .values({
      email: body.email.toLowerCase(),
      passwordHash: hashPassword(body.password),
      name: body.name,
      locale: body.locale ?? "en",
    })
    .returning();

  const token = await signToken({ userId: user.id, email: user.email });
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, locale: user.locale } });
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<{ email: string; password: string }>();
  const [user] = await db.select().from(users).where(eq(users.email, body.email?.toLowerCase() ?? ""));

  if (!user || !verifyPassword(body.password ?? "", user.passwordHash)) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const token = await signToken({ userId: user.id, email: user.email });
  return c.json({ token, user: { id: user.id, email: user.email, name: user.name, locale: user.locale } });
});

authRoutes.get("/me", async (c) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const { verifyToken } = await import("./auth.js");
  const payload = await verifyToken(token);
  if (!payload) return c.json({ error: "invalid_token" }, 401);

  const [user] = await db.select().from(users).where(eq(users.id, payload.userId));
  if (!user) return c.json({ error: "not_found" }, 404);

  return c.json({ user: { id: user.id, email: user.email, name: user.name, locale: user.locale } });
});
