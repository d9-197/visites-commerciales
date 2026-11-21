import express from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { tx } from '../db.js';
import type { Config } from '../config.js';
import { HttpError, wrap } from '../errors.js';
import { requireAuth, hashPassword } from '../auth.js';
import { withRevocations, previewModeImpact } from '../sync/revocations.js';

// Sous-ensemble de l'API d'administration, suffisant pour le prototype de synchro et de droits.
// Écarts avec api/admin.openapi.yaml : la création d'utilisateur fixe directement le mot de passe (pas de lien d'activation).
export function adminRouter(pool: Pool, cfg: Config) {
  const r = express.Router();
  r.use(requireAuth(pool, cfg, { admin: true }));

  r.post('/users', wrap(async (req, res) => {
    const b = z.object({
      email: z.string().email(), display_name: z.string(), role: z.enum(['commercial', 'manager', 'directeur']), password: z.string().min(12),
      is_admin: z.boolean().optional(), manager_id: z.string().uuid().optional(),
    }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    const d = b.data;
    const u = await tx(pool, async c => {
      const row = (await c.query(
        `INSERT INTO app_user(email, display_name, role, is_admin, manager_id, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, display_name, role, manager_id`,
        [d.email, d.display_name, d.role, d.is_admin ?? false, d.manager_id ?? null, await hashPassword(d.password)])).rows[0];
      await c.query('SELECT rebuild_hierarchy()');
      return row;
    }).catch(e => { if (e.code === '23505') throw new HttpError(409, 'email_taken', 'E-mail déjà utilisé'); throw e; });
    res.status(201).json({ user: u });
  }));

  r.patch('/users/:id', wrap(async (req, res) => {
    const b = z.object({ manager_id: z.string().uuid().nullable() }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    const out = await tx(pool, c => withRevocations(c, async () => {
      const cur = (await c.query(`SELECT id FROM app_user WHERE id = $1`, [req.params.id])).rows[0];
      if (!cur) throw new HttpError(404, 'not_found', 'Utilisateur inconnu');
      if (b.data.manager_id) {
        const cycle = (await c.query(`SELECT 1 FROM user_hierarchy WHERE ancestor_id = $1 AND descendant_id = $2`, [req.params.id, b.data.manager_id])).rows[0];
        if (cycle) throw new HttpError(409, 'hierarchy_cycle', 'Le supérieur ne peut pas être un subordonné');
      }
      await c.query(`UPDATE app_user SET manager_id = $2 WHERE id = $1`, [req.params.id, b.data.manager_id]);
      await c.query('SELECT rebuild_hierarchy()');
    }));
    res.json({ id: req.params.id, revoked: out.revoked });
  }));

  r.put('/companies/:id/assignments', wrap(async (req, res) => {
    const b = z.object({ user_ids: z.array(z.string().uuid()) }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    const out = await tx(pool, c => withRevocations(c, async () => {
      await c.query(`UPDATE company_assignment SET removed_at = now() WHERE company_id = $1 AND removed_at IS NULL AND NOT (user_id = ANY($2::uuid[]))`, [req.params.id, b.data.user_ids]);
      for (const uid of b.data.user_ids) {
        await c.query(`INSERT INTO company_assignment(company_id, user_id, source) VALUES ($1,$2,'admin')
                       ON CONFLICT (company_id, user_id) DO UPDATE SET removed_at = NULL, source = 'admin'`, [req.params.id, uid]);
      }
    }));
    res.json({ company_id: req.params.id, revoked: out.revoked });
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
        throw new HttpError(409, 'impact_confirmation_required', 'Confirmer l\'impact avant de changer le mode',
          { visits_becoming_visible: impact.becomingVisible, visits_becoming_hidden: impact.becomingHidden });
      }
    } finally { client.release(); }
    const out = await tx(pool, c => withRevocations(c, async () => {
      await c.query(`UPDATE app_setting SET value = to_jsonb($1::text), updated_at = now() WHERE key = 'report_visibility_mode'`, [String(mode)]);
    }));
    res.json({ report_visibility_mode: mode, revoked: out.revoked });
  }));

  return r;
}
