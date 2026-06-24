/**
 * /api/admin/slack-notifications  (admin only)
 *   GET  -> { notifications, config, defaultSandbox }
 *   POST -> { ok, config }   body: { config }
 *
 * The admin "Slack Notifications" table (Admin → Flows, below Approval Routing):
 * per-notification on/off + sandbox routing. Config is JSON on the admin Agent
 * record (read/writeSlackNotifConfig).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { readSlackNotifConfig, writeSlackNotifConfig, type SlackNotifConfigMap } from '@/lib/hubspot';
import { SLACK_NOTIFICATIONS, DEFAULT_SANDBOX_CHANNEL } from '@/lib/slackNotifications';

const KNOWN_KEYS = new Set(SLACK_NOTIFICATIONS.map((n) => n.key));

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    if (req.method === 'GET') {
      const config = await readSlackNotifConfig();
      return res.status(200).json({ notifications: SLACK_NOTIFICATIONS, config, defaultSandbox: DEFAULT_SANDBOX_CHANNEL });
    }
    if (req.method === 'POST') {
      const body = (req.body || {}) as { config?: Record<string, any> };
      const clean: SlackNotifConfigMap = {};
      for (const [k, v] of Object.entries(body.config || {})) {
        if (!KNOWN_KEYS.has(k) || !v || typeof v !== 'object') continue;
        const row: any = v;
        clean[k] = {
          enabled: row.enabled !== false,
          sandbox: row.sandbox === true,
          sandboxChannel: String(row.sandboxChannel || '').trim() || DEFAULT_SANDBOX_CHANNEL,
        };
      }
      await writeSlackNotifConfig(clean);
      return res.status(200).json({ ok: true, config: clean });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[slack-notifications] failed:', e);
    return res.status(400).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
