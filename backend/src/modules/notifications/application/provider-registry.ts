import { NotificationChannel } from "../domain/notification-channel";
import { NotificationProvider } from "../domain/notification-provider";

export class ProviderRegistry {
  private providers = new Map<
    NotificationChannel,
    NotificationProvider
  >();

  register(provider: NotificationProvider) {
    this.providers.set(provider.channel, provider);
  }

  get(channel: NotificationChannel) {
    return this.providers.get(channel);
  }

  has(channel: NotificationChannel) {
    return this.providers.has(channel);
  }

  all() {
    return [...this.providers.values()];
  }
}