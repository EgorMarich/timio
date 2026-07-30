// Это НЕ основной сценарий продукта - основной сценарий: пользователь регистрируется
// через /register и создаёт СВОЙ бизнес со своими услугами через онбординг (см. me.routes.ts).
// Этот скрипт лишь опционально наполняет БД одним демо-бизнесом для ручного тестирования
// публичной страницы записи без прохождения регистрации.
import { eq } from "drizzle-orm";
import { db, sql } from "./client.js";
import { users, businesses, businessMembers, services, staff, messageTemplates } from "./schema.js";
import { hashPassword } from "../modules/auth.js";
import { defaultTemplates } from "../modules/defaultTemplates.js";

const DEMO_EMAIL = "demo@timio.app";

async function seed() {
  const existingUser = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
  if (existingUser.length > 0) {
    console.log("Demo data already seeded, skipping. Login: demo@timio.app / demo12345");
    await sql.end();
    return;
  }

  const [owner] = await db
    .insert(users)
    .values({
      email: DEMO_EMAIL,
      passwordHash: hashPassword("demo12345"),
      name: "Demo Owner",
      locale: "ru",
    })
    .returning();

  const [business] = await db
    .insert(businesses)
    .values({
      ownerId: owner.id,
      slug: "demo-barbershop",
      name: "Demo Barbershop",
      niche: "barbershop",
      timezone: "Europe/Moscow",
      channelPriority: ["telegram", "whatsapp", "viber", "messenger", "sms", "email"],
      workingHours: {
        1: { start: 600, end: 1200 },
        2: { start: 600, end: 1200 },
        3: { start: 600, end: 1200 },
        4: { start: 600, end: 1200 },
        5: { start: 600, end: 1200 },
        6: { start: 660, end: 1080 },
        0: null,
      },
    })
    .returning();

  await db.insert(businessMembers).values({ businessId: business.id, userId: owner.id, role: "owner" });

  const [haircut] = await db
    .insert(services)
    .values({
      businessId: business.id,
      name: {
        ru: "Стрижка", en: "Haircut", es: "Corte de pelo", it: "Taglio di capelli",
        fr: "Coupe de cheveux", kk: "Шаш қию", hy: "Մազերի կտրվածք",
      },
      durationMin: 40,
      priceCents: 150000,
      currency: "RUB",
    })
    .returning();

  const [beard] = await db
    .insert(services)
    .values({
      businessId: business.id,
      name: {
        ru: "Борода", en: "Beard trim", es: "Arreglo de barba", it: "Rifinitura barba",
        fr: "Taille de barbe", kk: "Сақал алу", hy: "Մորուքի խնամք",
      },
      durationMin: 25,
      priceCents: 90000,
      currency: "RUB",
    })
    .returning();

  await db.insert(staff).values({
    businessId: business.id,
    name: "Alex",
    serviceIds: [haircut.id, beard.id],
    colorHex: "#FF4438",
  });

  await db.insert(messageTemplates).values(
    Object.entries(defaultTemplates).map(([type, translations]) => ({
      businessId: business.id,
      type,
      translations,
    }))
  );

  console.log("Seeded demo business:", business.slug);
  console.log("Demo login: demo@timio.app / demo12345");
  await sql.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
