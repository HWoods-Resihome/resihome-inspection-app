/**
 * /api/insights/access   (any authenticated user)
 *
 *   GET -> { authenticated, user, canView, isAdmin, isInsightsUser }
 *
 * Bootstrap for the /insights portal: the page renders dashboards only when
 * canView is true (canView = isAppAdmin OR isInsightsUser). isAdmin unlocks the
 * in-portal admin menu (manage Insights-Only users). The middleware already
 * requires a valid session before this route runs.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { isInsightsUser, canViewInsights } from '@/lib/insightsAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await getSessionFromRequest(req);
  if (!user) return res.status(401).json({ authenticated: false, canView: false });

  const [admin, insightsUser, canView] = await Promise.all([
    isAppAdmin(user.email),
    isInsightsUser(user.email),
    // THE gate — honors the per-user Insights toggle from User Management
    // (override wins), then falls back to admin / Insights-Only list. Using
    // admin||insightsUser here ignored the toggle: the hamburger (via
    // /api/auth/me) showed Insights but the portal said "access required".
    canViewInsights(user.email),
  ]);
  return res.status(200).json({
    authenticated: true,
    user,
    isAdmin: admin,
    isInsightsUser: insightsUser,
    canView,
  });
}
