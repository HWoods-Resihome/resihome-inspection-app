/**
 * Feature flags — currently just the PPW / Recurring Services initiative.
 *
 * PPW ("PPW Replacement", see RECURRING_SERVICES_PLAN.md) is developed on the
 * `recurring-services` branch and tested on its Vercel PREVIEW deployment. That
 * preview inherits PRODUCTION env vars — including the live HubSpot token — by
 * design (no sandbox portal). So two guardrails are non-negotiable while the
 * feature is in flight:
 *
 *   1) It must be INVISIBLE on production (main / resiwalk.com) until we
 *      deliberately turn it on. → gated on NEXT_PUBLIC_PPW_ENABLED, which is set
 *      Preview-scoped in Vercel and left UNSET in Production. Even if PPW code
 *      merges to main, prod stays dark until that var flips.
 *   2) Every server surface additionally requires an app-admin, so a normal
 *      inspector can never reach it even where the flag is on. → ppwEnabled().
 *
 * Because preview writes land in the LIVE portal, any HubSpot object PPW creates
 * from a non-production deploy must be stamped with PPW_TEST_MARKER (see
 * ppwWritesAreTest) so preview/test data is easy to find and delete in prod.
 *
 * This module is PURE + client-safe (no server-only imports) so client
 * components can read PPW_FLAG_ON without dragging HubSpot/server code into the
 * browser bundle. The admin-gated server check lives in lib/ppwAccess.ts.
 */

/**
 * Master switch, inlined into the client bundle (NEXT_PUBLIC_). ON when:
 *   • NEXT_PUBLIC_PPW_ENABLED === '1'  (set this Preview-scoped in Vercel), or
 *   • local dev (`next dev`) so the feature is visible without any config.
 * On a Vercel PRODUCTION build NODE_ENV is 'production' and the var is unset →
 * OFF, so resiwalk.com never shows PPW.
 */
export const PPW_FLAG_ON =
  process.env.NEXT_PUBLIC_PPW_ENABLED === '1' ||
  process.env.NODE_ENV !== 'production';

/**
 * True on any NON-production deploy (Vercel preview or local). Server-only —
 * VERCEL_ENV is not inlined into the client bundle. Future PPW write paths use
 * this to decide whether to stamp PPW_TEST_MARKER on created HubSpot objects.
 */
export const ppwWritesAreTest = process.env.VERCEL_ENV !== 'production';

/**
 * Stamp put on HubSpot objects PPW creates from a preview/test deploy, so they
 * can be filtered out of prod views and bulk-removed. Apply it (e.g. as a tag /
 * dedicated property) whenever ppwWritesAreTest is true.
 */
export const PPW_TEST_MARKER = 'ppw_preview_test';
