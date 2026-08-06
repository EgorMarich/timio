import { ProviderRegistry } from './application/provider-registry';
import { NotificationService } from './application/notification.service';
import { TemplateEngine } from './application/template-engine';
import { NotificationRepository } from './repositories/notification.repository';
import { TemplateRepository } from './repositories/template.repository';
import { BusinessSettingsRepository } from './repositories/business-settings.repository';

export class NotificationModule {
  
  readonly registry = new ProviderRegistry();
  readonly templateEngine = new TemplateEngine();
  readonly notificationRepository = new NotificationRepository();
  readonly templateRepository = new TemplateRepository();
  readonly settingsRepository = new BusinessSettingsRepository();

  readonly notifications = new NotificationService(
    this.registry,
    this.templateRepository,
    this.settingsRepository,
    this.notificationRepository,
    this.templateEngine,
  );
}
