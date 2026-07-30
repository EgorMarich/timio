import { NotificationChannel } from "./notification-channel";

export interface NotificationPayload {
  title?: string;

  message: string;

  subject?: string;

  html?: string;

  metadata?: Record<string, unknown>;
}

export interface NotificationRecipient {
  telegramId?: string;

  email?: string;

  phone?: string;

  vkId?: string;
}

export interface NotificationProvider {
  readonly channel: NotificationChannel;

  send(
    recipient: NotificationRecipient,
    payload: NotificationPayload
  ): Promise<void>;
}