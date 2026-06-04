/**
 * Who may CURATE the AI Knowledge Base — i.e. see the "AI Knowledge Base" link
 * on the inspections page, open the /ai-knowledge screen, and list / edit /
 * delete / add entries there.
 *
 * NOTE: this is the CURATION allowlist only. ANY authenticated inspector can
 * still ADD a knowledge entry by voice from the beta AI camera ("Teach AI") —
 * that path (POST /api/ai-knowledge) is intentionally left open to everyone.
 *
 * To grant access to someone else, add their email here (lowercase).
 */
export const AI_KNOWLEDGE_ADMINS = [
  'hwoods@resihome.com',
  'eric.williams@resihome.com',
  'mfarr@resihome.com',
];

export function isKnowledgeAdmin(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase();
  return AI_KNOWLEDGE_ADMINS.includes(e);
}
