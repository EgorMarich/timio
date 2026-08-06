import type { NotificationChannel } from "../../../types";

import type {
  NotificationRecipient,
  NotificationPayload,
} from "./notification.types";

export interface NotificationProvider {
  readonly channel: NotificationChannel;

  send(
    recipient: NotificationRecipient,
    payload: NotificationPayload,
  ): Promise<void>;
}