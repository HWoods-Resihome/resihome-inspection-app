/**
 * Vendor welcome email — sent to a NEWLY added vendor when they're created with
 * Eligible For Recurring on, and re-sendable per vendor from the Vendor
 * Management card (never mass-sent). Points them at the sign-in page; their
 * first sign-in walks the emailed-code password setup.
 */
import { sendNotificationEmail, appBaseUrl } from '@/lib/notifications/send';

export async function sendVendorWelcomeEmail(
  v: { name: string; email: string },
  req?: { headers: Record<string, any> } | null,
): Promise<{ sent: boolean; error?: string }> {
  const rows: Array<[string, string]> = [
    ['Company', v.name],
    ['Sign-in Email', v.email],
  ];
  return sendNotificationEmail({
    to: v.email,
    subject: 'Welcome to ResiWalk — your vendor account is ready',
    heading: 'Welcome to ResiWalk',
    intro: `${v.name} now has vendor access to ResiWalk, ResiHome's field services app — assigned work orders, evidence photos, and invoicing all live here. Sign in with this email address; the first time, we'll email you a verification code to set your password.`,
    rows,
    linkUrl: `${appBaseUrl(req)}/login`,
    linkLabel: 'Sign In To ResiWalk',
  });
}
