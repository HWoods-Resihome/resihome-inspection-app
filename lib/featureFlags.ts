/**
 * Feature flags — currently just the ResiWalk - Services initiative (in-house
 * recurring services: grass cuts, pool service, cleans, community contracts).
 *
 * NOTE ON NAMING: "PPW" is only shorthand for the incumbent external vendor this
 * project replaces — it must NEVER appear in code identifiers, env vars, routes,
 * or HubSpot fields/objects. Everything is named "Services" / SERVICES_*.
 *
 * Services is developed on the `recurring-services` branch and tested on its
 * Vercel PREVIEW deployment, which inherits PRODUCTION env vars — including the
 * live HubSpot token — by design (no sandbox portal). Two guardrails while in
 * flight:
 *   1) INVISIBLE on production (main / resiwalk.com) until deliberately enabled.
 *      → gated on NEXT_PUBLIC_SERVICES_ENABLED, set Preview-scoped in Vercel and
 *      left UNSET in Production. Even after code merges to main, prod stays dark.
 *   2) Every server surface additionally requires an app-admin → servicesEnabled()
 *      in lib/servicesAccess.ts.
 *
 * Because preview writes land in the LIVE portal, any HubSpot object Services
 * creates from a non-production deploy must be stamped with SERVICES_TEST_MARKER
 * (see servicesWritesAreTest) so preview/test data is easy to find and delete.
 *
 * This module is PURE + client-safe (no server-only imports) so client components
 * can read SERVICES_FLAG_ON without dragging server code into the browser bundle.
 * The admin-gated server check lives in lib/servicesAccess.ts.
 */

/**
 * Master switch, inlined into the client bundle (NEXT_PUBLIC_). ON when:
 *   • NEXT_PUBLIC_SERVICES_ENABLED === '1'  (set this Preview-scoped in Vercel), or
 *   • local dev (`next dev`) so the feature is visible without any config.
 * On a Vercel PRODUCTION build NODE_ENV is 'production' and the var is unset →
 * OFF, so resiwalk.com never shows Services.
 */
export const SERVICES_FLAG_ON =
  process.env.NEXT_PUBLIC_SERVICES_ENABLED === '1' ||
  process.env.NODE_ENV !== 'production';

/**
 * True on any NON-production deploy (Vercel preview or local). Server-only —
 * VERCEL_ENV is not inlined into the client bundle. Future Services write paths
 * use this to decide whether to stamp SERVICES_TEST_MARKER on created HubSpot
 * objects.
 */
export const servicesWritesAreTest = process.env.VERCEL_ENV !== 'production';

/**
 * Stamp put on HubSpot objects Services creates from a preview/test deploy, so
 * they can be filtered out of prod views and bulk-removed. Apply it (e.g. as a
 * dedicated property) whenever servicesWritesAreTest is true.
 */
export const SERVICES_TEST_MARKER = 'services_preview_test';
