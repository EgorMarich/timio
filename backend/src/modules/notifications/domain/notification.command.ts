import type { NotificationChannel } from "../../../types";

export interface NotifyCommand {
  businessId: string;
  clientId: string;
  appointmentId?: string;

  /**
   * Тип уведомления.
   * Должен совпадать с type в message_templates
   * Например:
   * appointment.created
   * appointment.cancelled
   * reminder
   */
  templateType: string;
  locale: string;
  variables: Record<string, unknown>;
  availableChannels: NotificationChannel[];
}