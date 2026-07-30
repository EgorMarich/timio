import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { businesses } from "../db/schema.js";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    // транслитерация базовых кириллических букв, чтобы slug был читаемым в URL на любом языке ввода
    .replace(/[а-яё]/g, (ch) => {
      const map: Record<string, string> = {
        а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
        й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
        у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
        э: "e", ю: "yu", я: "ya",
      };
      return map[ch] ?? ch;
    })
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "business";
}

/** Гарантирует уникальность slug: business-name, business-name-2, business-name-3... */
export async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let suffix = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await db.select().from(businesses).where(eq(businesses.slug, candidate));
    if (existing.length === 0) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}
