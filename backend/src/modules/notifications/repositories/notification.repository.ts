import { eq } from 'drizzle-orm';
import { db } from '../../../db/client';
import { notificationLogs } from '../../../db/schema';

export class NotificationRepository {
  async create(data: typeof notificationLogs.$inferInsert) {
    const [notification] = await db.insert(notificationLogs).values(data).returning();

    return notification;
  }

  async markAsSent(id: string) {
    await db
      .update(notificationLogs)
      .set({
        status: 'sent',
        sentAt: new Date(),
      })
      .where(eq(notificationLogs.id, id));
  }

  async markAsFailed(id: string, error: string) {
    await db
      .update(notificationLogs)
      .set({
        status: 'failed',
        error,
      })
      .where(eq(notificationLogs.id, id));
  }
}
