/**
 * ResiWalk email notifications — the CATALOG of user-toggleable notifications.
 * Pure/client-safe (no server imports) so the settings UI can import it. The
 * per-user preference read/write helpers live in ./prefs (server-only).
 */

export type NotificationKey =
  | 'inspection_completed'
  | 'service_assigned'
  | 'service_completed'
  | 'service_past_due';

export interface NotificationDef {
  key: NotificationKey;
  object: 'inspections' | 'services';
  label: string;
  description: string;
}

export const NOTIFICATIONS: NotificationDef[] = [
  { key: 'inspection_completed', object: 'inspections', label: 'Inspection completed',
    description: 'Email me a copy of the report (PDF attached) when an inspection I ran is completed.' },
  { key: 'service_assigned', object: 'services', label: 'New service assigned',
    description: 'Email me when a service is assigned to me, with a link to open it.' },
  { key: 'service_completed', object: 'services', label: 'Service completed',
    description: 'Email me the completion report (PDF attached) when one of my services is completed.' },
  { key: 'service_past_due', object: 'services', label: 'Service past due',
    description: 'Email me when one of my assigned services is past due and still needs completion.' },
];

export const NOTIFICATION_KEYS: NotificationKey[] = NOTIFICATIONS.map((n) => n.key);
