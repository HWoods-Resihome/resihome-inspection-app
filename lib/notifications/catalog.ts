/**
 * ResiWalk email notifications — the CATALOG of user-toggleable notifications.
 * Pure/client-safe (no server imports) so the settings UI can import it. The
 * per-user preference read/write helpers live in ./prefs (server-only).
 */

export type NotificationKey =
  | 'inspection_completed'
  | 'service_assigned'
  | 'service_completed'
  | 'service_past_due'
  | 'service_note';

export interface NotificationDef {
  key: NotificationKey;
  object: 'inspections' | 'services';
  label: string;
  description: string;
}

export const NOTIFICATIONS: NotificationDef[] = [
  { key: 'inspection_completed', object: 'inspections', label: 'Inspection Completed',
    description: 'Email me a copy of the report (PDF attached) when an inspection I ran is completed.' },
  { key: 'service_assigned', object: 'services', label: 'New Service Assigned',
    description: 'Email me when a service is assigned to me, with a link to open it.' },
  { key: 'service_completed', object: 'services', label: 'Service Completed',
    description: 'Email me the completion report (PDF attached) when one of my services is completed.' },
  { key: 'service_past_due', object: 'services', label: 'Service Past Due',
    description: 'Email me when one of my assigned services is past due and still needs completion.' },
  { key: 'service_note', object: 'services', label: 'Service Notes',
    description: 'Email me when a note is added to a service work order I\'m involved with — reply to the email to answer in the thread.' },
];

export const NOTIFICATION_KEYS: NotificationKey[] = NOTIFICATIONS.map((n) => n.key);
