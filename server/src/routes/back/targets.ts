import express from 'express';
import { z } from 'zod';
import type { Pool } from '../../db.js';
import { tx } from '../../db.js';
import { HttpError, wrap } from '../../errors.js';
import { scopeUsers, scopeNodes, subtree, inScope } from './scope.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const shift = (m: string, n: number) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthsBetween = (from: string, to: string) => { const out: string[] = []; for (let m = from; m <= to; m = shift(m, 1)) out.push(m); return out; };

/**
 * Objectifs mensuels de visites, en tableau : une ligne par visiteur, une colonne par mois. Lecture : le périmètre de l'utilisateur (un visiteur ne voit que le sien).
 * Écriture : administrateurs, responsables et directeurs, pour les utilisateurs de leur périmètre.
 * « Visites effectuées » d'un mois = visites `done` ou `validated` dont la date de référence (fin, sinon début, sinon date prévue) tombe dans le mois.
 */
export function targetsRouter(pool: Pool) {
  const r = express.Router();

  /** `from` / `to` (AAAA-MM, 24 mois au plus ; défaut : 2 mois précédents et 10 mois suivants), `node_id` (département et sous-départements), `user_id`. */
  r.get('/targets', wrap(async (req, res) => {
    const A = req.auth!; const cur = new Date().toISOString().slice(0, 7);
    const from = typeof req.query.from === 'string' && MONTH.test(req.query.from) ? req.query.from : shift(cur, -2);
    const to = typeof req.query.to === 'string' && MONTH.test(req.query.to) ? req.query.to : shift(cur, 10);
    if (from > to) throw new HttpError(400, 'validation_failed', 'La période est inversée');
    const months = monthsBetween(from, to);
    if (months.length > 24) throw new HttpError(400, 'validation_failed', 'Période trop longue (24 mois au plus)');
    const scope = A.role === 'commercial' && !A.isAdmin ? [A.id] : await scopeUsers(pool, req);
    const nodes = await scopeNodes(pool, req);
    let nodeFilter: string[] | null = null;
    if (typeof req.query.node_id === 'string' && req.query.node_id) {
      nodeFilter = await subtree(pool, req.query.node_id, nodes);
      if (!nodeFilter) throw new HttpError(404, 'not_found', 'Département hors de votre périmètre');
    }
    const userId = typeof req.query.user_id === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.user_id) ? req.query.user_id : null;
    const first = `${from}-01`; const end = `${shift(to, 1)}-01`;
    const users = (await pool.query(
      `SELECT u.id AS user_id, u.display_name AS name, u.role, u.status, u.is_admin FROM app_user u
       WHERE ($1::uuid[] IS NULL OR u.id = ANY($1)) AND ($2::uuid IS NULL OR u.id = $2)
         AND ($3::uuid[] IS NULL OR EXISTS (SELECT 1 FROM user_org uo WHERE uo.user_id = u.id AND uo.node_id = ANY($3)))
       ORDER BY u.display_name`, [scope, userId, nodeFilter])).rows;
    const ids = users.map(u => u.user_id as string);
    const t = ids.length ? (await pool.query(`SELECT user_id, to_char(month, 'YYYY-MM') AS m, target FROM visit_target WHERE user_id = ANY($1::uuid[]) AND month >= $2::date AND month < $3::date`, [ids, first, end])).rows : [];
    const d = ids.length ? (await pool.query(
      `SELECT v.author_id AS user_id, to_char(date_trunc('month', COALESCE(v.ended_at, v.started_at, v.planned_start)), 'YYYY-MM') AS m, count(*)::int AS n
       FROM visit v WHERE v.author_id = ANY($1::uuid[]) AND v.deleted_at IS NULL AND v.status IN ('done','validated')
         AND COALESCE(v.ended_at, v.started_at, v.planned_start) >= $2::date AND COALESCE(v.ended_at, v.started_at, v.planned_start) < $3::date
         AND ($4::uuid[] IS NULL OR v.org_node_id = ANY($4) OR v.author_id = $5::uuid)
       GROUP BY 1, 2`, [ids, first, end, nodes, A.id])).rows : [];
    res.json({ from, to, months, users: users.map(u => ({
      ...u,
      targets: Object.fromEntries(t.filter(x => x.user_id === u.user_id).map(x => [x.m, x.target as number])),
      done: Object.fromEntries(d.filter(x => x.user_id === u.user_id).map(x => [x.m, x.n as number])),
    })) });
  }));

  const body = z.object({ targets: z.array(z.object({ user_id: z.string().uuid(), month: z.string().regex(MONTH), target: z.number().int().min(0).max(9999).nullable() }).strict()).max(2000) }).strict();

  /** Définit (ou supprime, `target: null`) des objectifs, par utilisateur et par mois. */
  r.put('/targets', wrap(async (req, res) => {
    const A = req.auth!;
    if (!A.isAdmin && A.role === 'commercial') throw new HttpError(403, 'forbidden', 'Seuls les responsables, directeurs et administrateurs définissent les objectifs');
    const b = body.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Objectifs invalides (mois AAAA-MM, nombres entiers de 0 à 9999)');
    const scope = await scopeUsers(pool, req);
    for (const t of b.data.targets) if (!inScope(scope, t.user_id)) throw new HttpError(403, 'forbidden', 'Utilisateur hors de votre périmètre');
    await tx(pool, async c => {
      const ids = [...new Set(b.data.targets.map(t => t.user_id))];
      if (ids.length && (await c.query(`SELECT id FROM app_user WHERE id = ANY($1::uuid[])`, [ids])).rows.length !== ids.length) throw new HttpError(404, 'not_found', 'Utilisateur inconnu');
      for (const t of b.data.targets) {
        const month = `${t.month}-01`;
        if (t.target === null) await c.query(`DELETE FROM visit_target WHERE user_id = $1 AND month = $2`, [t.user_id, month]);
        else await c.query(`INSERT INTO visit_target(user_id, month, target, set_by) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, month) DO UPDATE SET target = EXCLUDED.target, set_by = EXCLUDED.set_by, updated_at = now()`, [t.user_id, month, t.target, A.id]);
      }
      await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id, detail) VALUES ($1,'visit_targets_set','visit_target',NULL,$2)`, [A.id, { count: b.data.targets.length }]);
    });
    res.json({ updated: b.data.targets.length });
  }));

  return r;
}
