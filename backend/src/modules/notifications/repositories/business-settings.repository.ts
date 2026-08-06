import { and, eq } from 'drizzle-orm';
import { db } from '../../../db/client';
import { businessNotificationSettings } from '../../../db/schema';
import { NotificationChannel } from '../../../types';

export class BusinessSettingsRepository {
  async get(businessId: string, event: string) {
    const [settings] = await db
      .select()
      .from(businessNotificationSettings)
      .where(
        and(
          eq(businessNotificationSettings.businessId, businessId),
          eq(businessNotificationSettings.event, event),
        ),
      );

    return settings;
  }

  async list(businessId: string) {
    return db
      .select()
      .from(businessNotificationSettings)
      .where(eq(businessNotificationSettings.businessId, businessId));
  }

  async saveMany(
    businessId: string,
    settings: {
      event: string;
      enabled: boolean;
      channels: NotificationChannel[];
    }[],
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(businessNotificationSettings)
        .where(eq(businessNotificationSettings.businessId, businessId));

      if (!settings.length) {
        return;
      }

      await tx.insert(businessNotificationSettings).values(
        settings.map((item) => ({
          businessId,
          event: item.event,
          enabled: item.enabled,
          channels: item.channels,
        })),
      );
    });
  }
}
