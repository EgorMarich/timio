export class NotificationProviderNotFoundError extends Error {
  constructor(channel: string) {
    super(
      `Notification provider "${channel}" not found`
    );
  }

}