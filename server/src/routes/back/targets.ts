import express from 'express';
import { z } from 'zod';
import type { Pool } from '../../db.js';
import { tx } from '../../db.js';
import { HttpError, wrap } from '../../errors.js';
import { scopeUsers, scopeNodes, inScope } from './scope.js';

const monthParam = (v: unknown): string => {
  const m = typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) ? v : new Date().toISOString().slice(0, 7);
  return `${m}-01`;
};

/**
 * Objectifs mensuels de visites. Lecture : le périmètre de l'utilisateur (un visiteur ne voit que le sien). Écriture : administrateurs, responsables et directeurs, pour les utilisateurs de leur périmètre.
 * « Visites effectuées » du mois = visites `done` ou `validated` dont la date de référence (fin, sinon début, sinon date prévue) tombe dans le mois.
 */
export function targetsRouter(pool: Pool) {
  const r = express.Router();

  r.get('/targets', wrap(async (req, res) => {
    const month = monthParam(req.query.month); const A = req.auth!;
    const scope = await scopeUsers(pool, req); const nodes = await scopeNodes(pool, req);
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.display_name AS name, u.role, u.status, t.target,
         (SELECT count(*)::int FROM visit v WHERE v.author_id = u.id AND v.deleted_at IS NULL AND v.status IN ('done','validated')
            AND COALESCE(v.ended_at, v.started_at, v.planned_start) >= $2::date AND COALESCE(v.ended_at, v.started_at, v.planned_start) < ($2::date + interval '1 month')
            AND ($3::uuid[] IS NULL OR v.org_node_id = ANY($3) OR v.author_id = $4::uuid)) AS done
       FROM app_user u LEFT JOIN visit_target t ON t.user_id = u.id AND t.month = $2::date
       WHERE ($1::uuid[] IS NULL OR u.id = ANY($1)) AND ((u.role = 'commercial' AND u.status = 'active' AND NOT u.is_admin) OR t.target IS NOT NULL)
       ORDER BY u.display_name`, [A.role === 'commercial' && !A.isAdmin ? [A.id] : scope, month, nodes, A.id]);
    res.json({ month: month.slice(0, 7), users: rows });
  }));

  const body = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), targets: z.array(z.object({ user_id: z.string().uuid(), target: z.number().int().min(0).max(9999).nullable() }).strict()).max(500) }).strict();

  /** Définit (ou supprime, `target: null`) les objectifs d'un mois. */
  r.put('/targets', wrap(async (req, res) => {
    const A = req.auth!;
    if (!A.isAdmin && A.role === 'commercial') throw new HttpError(403, 'forbidden', 'Seuls les responsables, directeurs et administrateurs définissent les objectifs');
    const b = body.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Objectifs invalides (nombres entiers de 0 à 9999)');
    const scope = await scopeUsers(pool, req); const month = `${b.data.month}-01`;
    for (const t of b.data.targets) if (!inScope(scope, t.user_id)) throw new HttpError(403, 'forbidden', 'Utilisateur hors de votre périmètre');
    await tx(pool, async c => {
      const known = (await c.query(`SELECT id FROM app_user WHERE id = ANY($1::uuid[])`, [b.data.targets.map(t => t.user_id)])).rows.length;
      if (known !== new Set(b.data.targets.map(t => t.user_id)).size) throw new HttpError(404, 'not_found', 'Utilisateur inconnu');
      for (const t of b.data.targets) {
        if (t.target === null) await c.query(`DELETE FROM visit_target WHERE user_id = $1 AND month = $2`, [t.user_id, month]);
        else await c.query(`INSERT INTO visit_target(user_id, month, target, set_by) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, month) DO UPDATE SET target = EXCLUDED.target, set_by = EXCLUDED.set_by, updated_at = now()`, [t.user_id, month, t.target, A.id]);
      }
      await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id, detail) VALUES ($1,'visit_targets_set','visit_target',NULL,$2)`, [A.id, { month: b.data.month, count: b.data.targets.length }]);
    });
    res.json({ month: b.data.month, updated: b.data.targets.length });
  }));

  return r;
}
