import { PPW_FLAG_ON } from '@/lib/featureFlags';

/**
 * A small always-visible marker shown ONLY where the PPW flag is on (the
 * `recurring-services` preview deployment and local dev). It renders null on
 * production (the flag is off there), so it can never appear on resiwalk.com.
 *
 * Its job is to make the risky part obvious: this preview talks to the LIVE
 * HubSpot portal, so anything PPW writes lands in production data. The badge
 * keeps that fact in front of whoever's testing.
 */
export default function PpwEnvBadge() {
  if (!PPW_FLAG_ON) return null;
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: 8,
        bottom: 'calc(8px + var(--sync-footer-h, 0px))',
        zIndex: 2147483646,
        pointerEvents: 'none',
        background: '#7c3aed',
        color: '#fff',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.3,
        padding: '3px 7px',
        borderRadius: 6,
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      PPW PREVIEW · writes to PROD HubSpot
    </div>
  );
}
