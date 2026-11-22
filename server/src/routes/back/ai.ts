import express from 'express';
import { z } from 'zod';
import type { Pool } from '../../db.js';
import { HttpError, wrap } from '../../errors.js';
import { sha256 } from '../../auth.js';
import { AiError, type AiServices, type BriefReport } from '../../ai/index.js';
import { aiUsage, resolveToday } from '../../ai/usage.js';

/**
 * IA de l'application back : brief d'un client pour préparer une réunion (visite). Mêmes règles de confidentialité que le brief mobile :
 * comptes rendus VALIDÉS et actions ouvertes que l'utilisateur peut lire (administrateur : ce que la fiche de préparation lui montre), jamais les brouillons,
 * notes internes ou privées, et le nom du client n'est pas transmis au fournisseur.
 */
export function backAiRouter(pool: Pool, ai?: AiServices) {
  const r = express.Router();
  const usage = aiUsage(pool, ai);
  const body = z.object({
    refresh: z.boolean().optional(), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    objective: z.string().trim().max(2000).nullable().optional(), preparation_notes: z.string().trim().max(5000).nullable().optional(), planned_start: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict();

  r.post('/prep/companies/:id/ai-brief', wrap(async (req, res) => {
    const b = body.safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    if (!ai) throw new HttpError(503, 'ai_unavailable', 'Le service d\'IA n\'est pas configuré');
    const A = req.auth!;
    const company = (await pool.query(`SELECT id FROM company WHERE id = $1 AND deleted_at IS NULL`, [req.params.id])).rows[0];
    const ok = company && (A.isAdmin || (await pool.query(`SELECT can_read_company($1,$2) AS ok`, [A.id, req.params.id])).rows[0].ok);
    if (!ok) throw new HttpError(404, 'not_found', 'Client inconnu');
    const today = resolveToday(b.data.today);
    const lang = (await pool.query(`SELECT dictation_language FROM app_user WHERE id = $1`, [A.id])).rows[0]?.dictation_language ?? 'fr';
    const reports: BriefReport[] = (await pool.query(
      `SELECT COALESCE(x.ended_at, x.started_at, x.planned_start) AS at, rp.opportunity_temperature AS temperature, rp.summary, rp.needs, rp.objections, rp.competitors, rp.decisions, rp.next_step
       FROM visit x JOIN visit_report rp ON rp.visit_id = x.id
       WHERE x.company_id = $1 AND x.deleted_at IS NULL AND rp.status = 'validated' AND ($2::boolean OR can_read_visit($3, x.id))
       ORDER BY COALESCE(x.ended_at, x.started_at, x.planned_start) DESC NULLS LAST LIMIT 5`, [company.id, A.isAdmin, A.id])).rows
      .map(x => ({ date: x.at ? new Date(x.at).toISOString().slice(0, 10) : null, temperature: x.temperature ?? null, summary: x.summary ?? '', needs: x.needs ?? '', objections: x.objections ?? '', competitors: x.competitors ?? '', decisions: x.decisions ?? '', next_step: x.next_step ?? '' }));
    const openActions = (await pool.query(
      `SELECT a.title, a.due_date::text AS due_date FROM action_item a WHERE a.company_id = $1 AND a.status = 'todo' AND ($2::boolean OR can_read_action($3, a.id)) ORDER BY a.due_date NULLS LAST, a.created_at LIMIT 15`, [company.id, A.isAdmin, A.id])).rows
      .map(a => ({ title: a.title as string, due_date: (a.due_date as string | null) ?? null, late: !!a.due_date && a.due_date < today }));
    const objective = b.data.objective?.trim() || null; const prep = b.data.preparation_notes?.trim() || null; const plannedStart = b.data.planned_start ?? null;
    const sources = { reports: reports.length, actions: openActions.length };
    if (reports.length === 0 && openActions.length === 0 && !objective && !prep) { res.json({ company_id: company.id, empty: true, brief: null, warnings: [], sources, cached: false }); return; }
    const hash = sha256(JSON.stringify({ lang, reports, openActions, objective, prep, plannedStart }));
    if (!b.data.refresh) {
      const c = (await pool.query(`SELECT brief, warnings, model, created_at FROM ai_company_brief WHERE company_id = $1 AND user_id = $2 AND source_hash = $3`, [company.id, A.id, hash])).rows[0];
      if (c) { res.json({ company_id: company.id, empty: false, brief: c.brief, warnings: c.warnings, model: c.model, generated_at: c.created_at, sources, cached: true }); return; }
    }
    if (!usage.rateOk(A.id)) throw new HttpError(429, 'rate_limited', 'Trop de demandes d\'IA, réessayez dans une minute');
    if (!(await usage.budgetOk(A.id))) throw new HttpError(402, 'quota_exceeded', 'Plafond mensuel d\'IA atteint');
    const glossary = (await pool.query(`SELECT term FROM glossary_term WHERE deleted_at IS NULL AND language = $1 AND (scope = 'global' OR user_id = $2) ORDER BY term LIMIT 50`, [lang, A.id])).rows.map(x => x.term as string);
    let result;
    try { result = await ai.service.brief({ language: lang, today, objective, preparationNotes: prep, plannedStart, reports, openActions, glossary }); }
    catch (e) { if (e instanceof AiError) throw new HttpError(e.kind === 'unavailable' ? 503 : 502, e.kind === 'unavailable' ? 'ai_unavailable' : 'ai_failed', e.message); throw e; }
    await pool.query(
      `INSERT INTO ai_company_brief(company_id, user_id, source_hash, brief, warnings, model) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, user_id) DO UPDATE SET source_hash = EXCLUDED.source_hash, brief = EXCLUDED.brief, warnings = EXCLUDED.warnings, model = EXCLUDED.model, created_at = now()`,
      [company.id, A.id, hash, result.brief, JSON.stringify(result.warnings), result.model]);
    await usage.logUsage(A.id, result);
    res.json({ company_id: company.id, empty: false, brief: result.brief, warnings: result.warnings, model: result.model, generated_at: new Date().toISOString(), sources, cached: false });
  }));

  return r;
}
