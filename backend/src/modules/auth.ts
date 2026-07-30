import { SignJWT, jwtVerify } from "jose";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? "timio-dev-secret-change-me");

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, derived] = stored.split(":");
  const check = scryptSync(password, salt, 64);
  const original = Buffer.from(derived, "hex");
  return original.length === check.length && timingSafeEqual(original, check);
}

export async function signToken(payload: { userId: string; email: string }): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<{ userId: string; email: string } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as { userId: string; email: string };
  } catch {
    return null;
  }
}
