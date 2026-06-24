/**
 * lib/slackNotifications.ts — the registry + admin config for ResiWalk's Slack
 * notifications. Each notification has a stable key; the admin "Slack
 * Notifications" table stores per-key { enabled, sandbox, sandboxChannel } as
 * JSON on the Agent record (readSlackNotifConfig/writeSlackNotifConfig).
 *
 * resolveSlackTarget(key, intendedChannel) is the single gate every notification
 * calls: it returns whether the notification is enabled and which channel to use
 * (the real one, or the sandbox channel when sandbox mode is on).
 */
import { readSlackNotifConfig, type SlackNotifConfigMap } from '@/lib/hubspot';

export const DEFAULT_SANDBOX_CHANNEL = 'C06CW2VMJNR';

/** The notifications surfaced in the admin table (stable keys + display names). */
export const SLACK_NOTIFICATIONS: { key: string; name: string }[] = [
  { key: 'scope_pending', name: 'Scope Review — Pending Approval' },
  { key: 'scope_approved', name: 'Scope Review — Approved' },
  { key: 'listing_price', name: '1099 Listing Price Recommendation' },
];

export interface ResolvedSlackTarget {
  enabled: boolean;       // false → caller should skip posting entirely
  channel: string;        // where to post (sandbox channel when sandbox on)
  sandbox: boolean;       // true → currently rerouted to a sandbox channel
}

/**
 * Resolve a notification's on/off + channel against the admin config.
 * Defaults (no saved config) are ENABLED + real channel, so notifications keep
 * working before anyone opens the admin table.
 */
export function resolveSlackTargetFromConfig(
  cfg: SlackNotifConfigMap,
  key: string,
  intendedChannel: string,
): ResolvedSlackTarget {
  const c = cfg[key] || {};
  const enabled = c.enabled !== false; // default ON
  const sandbox = c.sandbox === true;
  const channel = sandbox ? (c.sandboxChannel?.trim() || DEFAULT_SANDBOX_CHANNEL) : intendedChannel;
  return { enabled, channel, sandbox };
}

/** Read the config and resolve a single notification's target. */
export async function resolveSlackTarget(key: string, intendedChannel: string): Promise<ResolvedSlackTarget> {
  const cfg = await readSlackNotifConfig().catch(() => ({} as SlackNotifConfigMap));
  return resolveSlackTargetFromConfig(cfg, key, intendedChannel);
}
