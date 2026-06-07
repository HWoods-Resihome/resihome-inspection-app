/**
 * /api/admin/questions   (app-admin only)
 *
 *   GET  ?template=<id>  -> { questions }   all questions for an EDITABLE template,
 *                                           including disabled ones (for the builder)
 *   POST { ...question }  -> { ok, id }      create a new question
 *
 * Scope Rate Card and Turn Re-Inspect QC are hard-locked — never editable here.
 * Syncs to the HubSpot inspection_question object. See lib/formBuilder.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchQuestionsForTemplate, createQuestionRecord } from '@/lib/hubspot';
import { isProtectedTemplate, RESPONSE_TYPE_VALUES, questionInputToProps, type QuestionInput } from '@/lib/formBuilder';
import { isEditableTemplateAsync } from '@/lib/formTemplates';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  try {
    if (req.method === 'GET') {
      const template = String(req.query.template || '').trim();
      if (!(await isEditableTemplateAsync(template))) return res.status(400).json({ error: 'Unknown or locked template.' });
      const { questions } = await fetchQuestionsForTemplate(template, { includeDisabled: true });
      return res.status(200).json({ template, questions });
    }

    if (req.method === 'POST') {
      const input = (req.body || {}) as QuestionInput;
      const applies = input.appliesToTemplates || [];
      if (!input.questionText || !String(input.questionText).trim()) return res.status(400).json({ error: 'Question text is required.' });
      if (!applies.length) return res.status(400).json({ error: 'Choose at least one template.' });
      if (applies.some(isProtectedTemplate)) return res.status(403).json({ error: 'Scope and QC templates are locked.' });
      const editable = await Promise.all(applies.map((t) => isEditableTemplateAsync(t)));
      if (!editable.every(Boolean)) return res.status(400).json({ error: 'One or more templates are not editable.' });
      if (input.responseType && !RESPONSE_TYPE_VALUES.includes(input.responseType)) return res.status(400).json({ error: 'Invalid answer type.' });

      const externalId = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const props = {
        question_id_external: externalId,
        ...questionInputToProps({ enabled: true, responseType: 'text', ...input }),
      };
      const id = await createQuestionRecord(props);
      return res.status(200).json({ ok: true, id, questionIdExternal: externalId });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[admin/questions] failed:', e);
    const msg = String(e?.message || e);
    const hint = (msg.includes('PROPERTY_DOESNT_EXIST') || msg.includes('does not exist'))
      ? ' — the is_enabled property may be missing; run scripts/forms/add_question_props.py.' : '';
    return res.status(400).json({ error: msg.slice(0, 280) + hint });
  }
}
