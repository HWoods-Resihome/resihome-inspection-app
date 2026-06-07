/**
 * /api/admin/questions/[id]   (app-admin only)
 *
 *   PATCH { ...fields }  -> edit a question (text, type, options, order,
 *                           required, help, enabled, section, applies)
 *   DELETE               -> archive (remove) a question
 *
 * Guard: a question attached to a LOCKED template (Scope / Turn Re-Inspect QC)
 * can't be edited or deleted here, and you can't move a question ONTO a locked
 * template. Syncs to the HubSpot inspection_question object.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { getQuestionAppliesToTemplates, updateQuestionRecord, archiveQuestionRecords } from '@/lib/hubspot';
import {
  touchesProtectedTemplate, isProtectedTemplate, isEditableTemplate,
  RESPONSE_TYPE_VALUES, questionInputToProps, type QuestionInput,
} from '@/lib/formBuilder';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing question id' });

  try {
    // Guard: never touch a question that belongs to a locked template.
    const currentApplies = await getQuestionAppliesToTemplates(id);
    if (currentApplies === null) return res.status(404).json({ error: 'Question not found.' });
    if (touchesProtectedTemplate(currentApplies)) {
      return res.status(403).json({ error: 'This question belongs to a locked (Scope/QC) template and can’t be edited here.' });
    }

    if (req.method === 'PATCH') {
      const input = (req.body || {}) as QuestionInput;
      if (input.responseType && !RESPONSE_TYPE_VALUES.includes(input.responseType)) {
        return res.status(400).json({ error: 'Invalid answer type.' });
      }
      if (input.appliesToTemplates) {
        if (input.appliesToTemplates.some(isProtectedTemplate)) return res.status(403).json({ error: 'Scope and QC templates are locked.' });
        if (!input.appliesToTemplates.every(isEditableTemplate)) return res.status(400).json({ error: 'One or more templates are not editable.' });
        if (!input.appliesToTemplates.length) return res.status(400).json({ error: 'A question must belong to at least one template.' });
      }
      const props = questionInputToProps(input);
      if (Object.keys(props).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
      await updateQuestionRecord(id, props);
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await archiveQuestionRecords([id]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error(`[admin/questions/${id}] ${req.method} failed:`, e);
    const msg = String(e?.message || e);
    const hint = (msg.includes('PROPERTY_DOESNT_EXIST') || msg.includes('does not exist'))
      ? ' — the is_enabled property may be missing; run scripts/forms/add_question_props.py.' : '';
    return res.status(400).json({ error: msg.slice(0, 280) + hint });
  }
}
