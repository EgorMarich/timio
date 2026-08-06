import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client";
import { messageTemplates } from "../../../db/schema";

export class TemplateRepository {
  async find(
    businessId: string,
    type: string,
  ) {
    const [template] = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.businessId, businessId),
          eq(messageTemplates.type, type),
        ),
      );

    return template;
  }
}