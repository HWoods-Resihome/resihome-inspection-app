/**
 * Who may FINALIZE their OWN submitted inspection — i.e. bypass the dual-layer
 * approval lock.
 *
 * The model: whoever SUBMITS an inspection for approval can never finalize it
 * themselves — a second reviewer (any other signed-in user) must finalize it.
 * That second human is the approval layer. The ONLY exception is an admin in
 * this list, who may finalize even work they submitted (an escape hatch for the
 * operator running the system).
 *
 * Shared by the client (greys out Finalize) and the server (hard-blocks it) so
 * the two never disagree. To grant the bypass to someone, add their email here
 * (lowercase).
 */
export const FINALIZE_ADMINS = [
  'hwoods@resihome.com',
];

export function isFinalizeAdmin(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase();
  return FINALIZE_ADMINS.includes(e);
}
