import { type NotificationChannel } from '../../../types';
import { SendNotificationCommand } from '../domain/notification.types';
import type { NotifyCommand } from '../domain/notification.command';
import { ProviderRegistry } from './provider-registry';
import { NotificationProviderNotFoundError } from '../domain/notification.errors';
import { TemplateRepository } from '../repositories/template.repository';
import { BusinessSettingsRepository } from '../repositories/business-settings.repository';
import { NotificationRepository } from '../repositories/notification.repository';
import { TemplateEngine } from './template-engine';

export class NotificationService {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly templateRepository: TemplateRepository,
    private readonly settingsRepository: BusinessSettingsRepository,
    private readonly notificationRepository: NotificationRepository,
    private readonly templateEngine: TemplateEngine,
  ) {}

  async send(command: SendNotificationCommand) {
    const provider = this.registry.get(command.channel);

    if (!provider) {
      throw new NotificationProviderNotFoundError(command.channel);
    }

    await provider.send(
      command.recipient,

      command.payload,
    );
  }

  async notify(command: NotifyCommand) {
    const settings = await this.settingsRepository.get(command.businessId, command.templateType);

    if (!settings?.enabled) {
      return;
    }

    const template = await this.templateRepository.find(command.businessId, command.templateType);

    if (!template) {
      throw new Error(`Template "${command.templateType}" not found`);
    }

    const rawTemplate =
      template.translations[command.locale] ??
      template.translations['en'] ??
      Object.values(template.translations)[0];

    const rendered = this.templateEngine.render(rawTemplate, command.variables);

    return {
      settings,
      rendered,
    };
  }

  async getBusinessSettings(businessId: string) {
    return this.settingsRepository.list(businessId);
  }

  async updateBusinessSettings(
    businessId: string,
    settings: {
      event: string;
      enabled: boolean;
      channels: NotificationChannel[];
    }[],
  ) {
    await this.settingsRepository.saveMany(businessId, settings);
  }
}
