import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from '../../db.js';
import { tx } from '../../db.js';
import { HttpError, wrap } from '../../errors.js';
import { hashPassword } from '../../auth.js';
import { withRevocations, previewModeImpact } from '../../sync/revocations.js';

const tempPassword = () => randomBytes(12).toString('base64url');   // 16 caractères, affiché une seule fois
const uuid = z.string().uuid();
const LANG = z.enum(['fr', 'en', 'es', 'it', 'de', 'nl']);

const USER_SQL = `SELECT u.id, u.email, u.display_name, u.role, u.is_admin, u.status,
  u.dictation_language, u.ai_budget_cents, u.last_login_at, u.created_at,
  COALESCE((SELECT json_agg(json_build_object('id', n.id, 'name', n.name, 'path', org_path(n.id)) ORDER BY org_path(n.id))
            FROM user_org uo JOIN org_node n ON n.id = uo.node_id WHERE uo.user_id = u.id), '[]'::json) AS nodes
  FROM app_user u`;

/** Comptes et réglages : administrateurs seulement. Le périmètre de chacun découle de son affectation aux nœuds de l'organisation. */
export function usersRouter(pool: Pool) {
  const r = express.Router();
  // Le contrôle du droit administrateur est posé par le routeur parent sur /users et /settings.

  r.get('/users', wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const node = typeof req.query.node_id === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.node_id) ? req.query.node_id : null;
    const { rows } = await pool.query(
      `${USER_SQL} WHERE ($1 = '' OR u.email ILIKE '%'||$1||'%' OR u.display_name ILIKE '%'||$1||'%')
         AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM user_org uo JOIN org_closure c ON c.descendant_id = uo.node_id WHERE uo.user_id = u.id AND c.ancestor_id = $2))
       ORDER BY u.display_name`, [q, node]);
    res.json({ users: rows });
  }));

  const create = z.object({
    email: z.string().trim().email(), display_name: z.string().trim().min(1).max(100), role: z.enum(['commercial', 'manager', 'directeur']),
    node_ids: z.array(uuid).max(50).optional(), is_admin: z.boolean().optional(), password: z.string().min(12).optional(),
    dictation_language: LANG.optional(), ai_budget_cents: z.number().int().min(0).nullable().optional(),
  }).strict();

  /** Affectation aux nœuds de l'organisation : au moins un nœud, sauf pour un compte administrateur (qui voit tout par ce droit). */
  async function setNodes(c: { query: Pool['query'] }, userId: string, nodeIds: string[], isAdmin: boolean) {
    const ids = [...new Set(nodeIds)];
    if (ids.length === 0 && !isAdmin) throw new HttpError(400, 'validation_failed', "Affectez le compte à au moins un département de l'organisation");
    if (ids.length) {
      const ok = (await c.query(`SELECT count(*)::int AS n FROM org_node WHERE id = ANY($1::uuid[])`, [ids])).rows[0].n;
      if (ok !== ids.length) throw new HttpError(404, 'not_found', 'Département inconnu');
    }
    await c.query(`DELETE FROM user_org WHERE user_id = $1`, [userId]);
    for (const n of ids) await c.query(`INSERT INTO user_org(user_id, node_id) VALUES ($1,$2)`, [userId, n]);
  }

  r.post('/users', wrap(async (req, res) => {
    const b = create.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const d = b.data; const password = d.password ?? tempPassword();
    const user = await tx(pool, async c => {
      const row = (await c.query(
        `INSERT INTO app_user(email, display_name, role, is_admin, password_hash, dictation_language, ai_budget_cents) VALUES ($1,$2,$3,$4,$5,COALESCE($6,'fr'),$7) RETURNING id`,
        [d.email, d.display_name, d.role, d.is_admin ?? false, await hashPassword(password), d.dictation_language ?? null, d.ai_budget_cents ?? null])).rows[0];
      await setNodes(c, row.id, d.node_ids ?? [], d.is_admin ?? false);
      await c.query('SELECT rebuild_hierarchy()');
      await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id, detail) VALUES ($1,'user_created','app_user',$2,$3)`, [req.auth!.id, row.id, { role: d.role }]);
      return row.id as string;
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'email_taken', 'E-mail déjà utilisé'); throw e; });
    const created = (await pool.query(`${USER_SQL} WHERE u.id = $1`, [user])).rows[0];
    res.status(201).json({ user: created, ...(d.password ? {} : { temporary_password: password }) });
  }));

  const patch = z.object({
    email: z.string().trim().email().optional(), display_name: z.string().trim().min(1).max(100).optional(), role: z.enum(['commercial', 'manager', 'directeur']).optional(),
    is_admin: z.boolean().optional(), node_ids: z.array(uuid).max(50).optional(), status: z.enum(['active', 'disabled']).optional(),
    dictation_language: LANG.optional(), ai_budget_cents: z.number().int().min(0).nullable().optional(),
  }).strict();

  r.patch('/users/:id', wrap(async (req, res) => {
    const b = patch.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const f = b.data; const id = req.params.id!;
    if (id === req.auth!.id && (f.status === 'disabled' || f.is_admin === false)) throw new HttpError(409, 'self_lockout', 'Vous ne pouvez pas retirer vos propres droits ni désactiver votre compte');
    const out = await tx(pool, c => withRevocations(c, async () => {
      const cur = (await c.query(`SELECT * FROM app_user WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw new HttpError(404, 'not_found', 'Utilisateur inconnu');
      const { node_ids, ...fields } = f;
      const cols = Object.keys(fields) as (keyof typeof fields)[];
      if (cols.length) await c.query(`UPDATE app_user SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...cols.map(k => fields[k])]);
      if (node_ids) await setNodes(c, id, node_ids, fields.is_admin ?? cur.is_admin);
      if (cols.length || node_ids) {
        if (node_ids || 'role' in f) await c.query('SELECT rebuild_hierarchy()');
        if (f.status === 'disabled') {   // sessions révoquées : plus aucune synchronisation ni connexion
          await c.query(`UPDATE refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
          await c.query(`UPDATE device SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
        }
        await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id, detail) VALUES ($1,$2,'app_user',$3,$4)`,
          [req.auth!.id, f.status === 'disabled' ? 'user_disabled' : 'user_updated', id, { fields: [...cols, ...(node_ids ? ['node_ids'] : [])] }]);
      }
    }));
    const row = (await pool.query(`${USER_SQL} WHERE u.id = $1`, [id])).rows[0];
    res.json({ user: row, revoked: out.revoked });
  }));

  r.post('/users/:id/reset-password', wrap(async (req, res) => {
    const b = z.object({ password: z.string().min(12).optional() }).safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Mot de passe de 12 caractères minimum');
    const password = b.data.password ?? tempPassword();
    const r2 = await tx(pool, async c => {
      const u = await c.query(`UPDATE app_user SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1 RETURNING id`, [req.params.id, await hashPassword(password)]);
      if (!u.rows[0]) throw new HttpError(404, 'not_found', 'Utilisateur inconnu');
      await c.query(`UPDATE refresh_token SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [req.params.id]);
      await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id) VALUES ($1,'password_reset','app_user',$2)`, [req.auth!.id, req.params.id]);
      return true;
    });
    void r2;
    res.json({ ...(b.data.password ? {} : { temporary_password: password }), id: req.params.id });
  }));

  r.get('/settings', wrap(async (_req, res) => {
    const m = (await pool.query(`SELECT visibility_mode() AS m`)).rows[0].m;
    res.json({ report_visibility_mode: m });
  }));

  r.put('/settings', wrap(async (req, res) => {
    const b = z.object({ report_visibility_mode: z.union([z.literal(1), z.literal(2)]), confirm_impact: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    const mode = b.data.report_visibility_mode;
    const client = await pool.connect();
    try {
      const current = (await client.query(`SELECT visibility_mode() AS m`)).rows[0].m;
      if (current !== mode && !b.data.confirm_impact) {
        const impact = await previewModeImpact(client, mode);
        throw new HttpError(409, 'impact_confirmation_required', "Confirmer l'impact avant de changer le mode", { visits_becoming_visible: impact.becomingVisible, visits_becoming_hidden: impact.becomingHidden });
      }
    } finally { client.release(); }
    const out = await tx(pool, c => withRevocations(c, async () => {
      await c.query(`UPDATE app_setting SET value = to_jsonb($1::text), updated_at = now() WHERE key = 'report_visibility_mode'`, [String(mode)]);
      await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, detail) VALUES ($1,'setting_changed','report_visibility_mode',$2)`, [req.auth!.id, { mode }]);
    }));
    res.json({ report_visibility_mode: mode, revoked: out.revoked });
  }));

  return r;
}
