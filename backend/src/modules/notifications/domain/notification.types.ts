import { NotificationChannel } from '../../../types';

export interface NotificationRecipient {
  telegramChatId?: string;
  email?: string;
  phone?: string;
  vkId?: string;
}

export interface NotificationPayload {
  subject?: string;
  title?: string;
  message: string;
  html?: string;
  metadata?: Record<string, unknown>;
}

export interface SendNotificationCommand {
  channel: NotificationChannel;
  recipient: NotificationRecipient;
  payload: NotificationPayload;
}
