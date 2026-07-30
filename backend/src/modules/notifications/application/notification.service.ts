import { ProviderRegistry } from "./provider-registry";
import {
  NotificationChannel,
} from "../domain/notification-channel";
import {
  NotificationPayload,
  NotificationRecipient,
} from "../domain/notification-provider";

export class NotificationService {
  constructor(
    private readonly registry: ProviderRegistry
  ) {}

  async send(
    channel: NotificationChannel,
    recipient: NotificationRecipient,
    payload: NotificationPayload
  ) {
    const provider = this.registry.get(channel);

    if (!provider) {
      throw new Error(
        `Provider ${channel} not registered`
      );
    }

    await provider.send(recipient, payload);
  }
}