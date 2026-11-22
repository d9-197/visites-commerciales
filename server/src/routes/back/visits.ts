import express from 'express';
import type { Pool } from '../../db.js';
import { HttpError, wrap } from '../../errors.js';
import { scopeUsers, inScope, day, pagination } from './scope.js';

const STATUSES = ['planned', 'organized', 'in_progress', 'done', 'validated', 'cancelled', 'deleted'];

/** Consultation des visites, comptes rendus et actions (comme le ferait le CRM), limitée au périmètre. Jamais les notes internes ni privées. */
export function visitsRouter(pool: Pool) {
  const r = express.Router();

  r.get('/visits', wrap(async (req, res) => {
    const scope = await scopeUsers(pool, req);
    const uid = typeof req.query.user_id === 'string' ? req.query.user_id : undefined;
    if (uid && !inScope(scope, uid)) throw new HttpError(404, 'not_found', 'Utilisateur hors de votre périmètre');
    const status = STATUSES.includes(String(req.query.status)) ? String(req.query.status) : null;
    const q = String(req.query.q ?? '').trim(); const from = day(req.query.from) ?? null; const to = day(req.query.to) ?? null;
    const company = typeof req.query.company_id === 'string' ? req.query.company_id : null;
    const { limit, offset } = pagination(req);
    const A = req.auth!;
    const where = `v.deleted_at IS NULL AND ($1::uuid[] IS NULL OR v.author_id = ANY($1)) AND ($2::boolean OR can_read_visit($3, v.id))
      AND ($4::text IS NULL OR v.status = $4) AND ($5 = '' OR c.name ILIKE '%'||$5||'%') AND ($6::date IS NULL OR COALESCE(v.ended_at, v.started_at, v.planned_start) >= $6::date)
      AND ($7::date IS NULL OR COALESCE(v.ended_at, v.started_at, v.planned_start) < $7::date + 1) AND ($8::uuid IS NULL OR v.company_id = $8::uuid)
      AND ($9::boolean OR v.status <> 'deleted')`;
    const P = [uid ? [uid] : scope, A.isAdmin, A.id, status, q, from, to, company, status === 'deleted'];
    const total = (await pool.query(`SELECT count(*)::int AS n FROM visit v JOIN company c ON c.id = v.company_id WHERE ${where}`, P)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT v.id, v.company_id, c.name AS company, v.author_id, u.display_name AS author, v.status, v.planned_start, v.started_at, v.ended_at, v.objective,
         r.status AS report_status, r.opportunity_temperature AS temperature,
         (SELECT count(*)::int FROM action_item x WHERE x.visit_id = v.id AND x.status = 'todo') AS open_actions,
         (v.status = 'validated' AND NOT EXISTS (SELECT 1 FROM action_item x WHERE x.visit_id = v.id AND x.status = 'todo')) AS closed
       FROM visit v JOIN company c ON c.id = v.company_id JOIN app_user u ON u.id = v.author_id LEFT JOIN visit_report r ON r.visit_id = v.id
       WHERE ${where} ORDER BY COALESCE(v.ended_at, v.started_at, v.planned_start) DESC NULLS LAST LIMIT $10 OFFSET $11`, [...P, limit, offset]);
    res.json({ total, visits: rows });
  }));

  r.get('/visits/:id', wrap(async (req, res) => {
    const scope = await scopeUsers(pool, req); const A = req.auth!;
    const v = (await pool.query(
      `SELECT v.*, c.name AS company, u.display_name AS author, cb.display_name AS created_by_name FROM visit v JOIN company c ON c.id = v.company_id JOIN app_user u ON u.id = v.author_id LEFT JOIN app_user cb ON cb.id = v.created_by
       WHERE v.id = $1 AND v.deleted_at IS NULL`, [req.params.id])).rows[0];
    const ok = v && inScope(scope, v.author_id) && (A.isAdmin || (await pool.query(`SELECT can_read_visit($1,$2) AS ok`, [A.id, v.id])).rows[0].ok);
    if (!ok) throw new HttpError(404, 'not_found', 'Visite inconnue');
    const report = (await pool.query(`SELECT summary, needs, objections, competitors, decisions, next_step, opportunity_temperature, draft_actions, status, validated_at, no_action FROM visit_report WHERE visit_id = $1`, [v.id])).rows[0] ?? null;
    const actions = (await pool.query(`SELECT x.id, x.title, x.due_date::text AS due_date, x.status, x.origin, u.display_name AS owner, x.completed_at FROM action_item x JOIN app_user u ON u.id = x.owner_id WHERE x.visit_id = $1 ORDER BY x.due_date NULLS LAST, x.created_at`, [v.id])).rows;
    const notes = (await pool.query(`SELECT id, kind, body, noted_at FROM visit_note WHERE visit_id = $1 AND deleted_at IS NULL ORDER BY noted_at, created_at`, [v.id])).rows;
    const history = (await pool.query(`SELECT field, old_value, new_value, changed_by_name, changed_at FROM visit_history WHERE visit_id = $1 ORDER BY changed_at, id`, [v.id])).rows;
    const emails = (await pool.query(`SELECT e.created_at, e.recipients, e.parts, e.status, u.display_name AS sender FROM visit_email e JOIN app_user u ON u.id = e.sender_id WHERE e.visit_id = $1 ORDER BY e.created_at`, [v.id])).rows;
    res.json({ visit: { id: v.id, company_id: v.company_id, company: v.company, author_id: v.author_id, author: v.author, created_by_name: v.created_by_name, status: v.status, planned_start: v.planned_start, started_at: v.started_at,
      ended_at: v.ended_at, location_text: v.location_text, objective: v.objective, preparation_notes: v.preparation_notes }, report, actions, notes, history, emails });
  }));

  return r;
}
