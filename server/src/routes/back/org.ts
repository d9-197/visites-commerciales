import express from 'express';
import { z } from 'zod';
import type { Pool } from '../../db.js';
import { tx } from '../../db.js';
import { HttpError, wrap } from '../../errors.js';
import { withRevocations } from '../../sync/revocations.js';
import { requireAdmin, scopeNodes } from './scope.js';

const name = z.string().trim().min(1).max(100);
const uuid = z.string().uuid();

/** Organisation arborescente. Lecture de ses propres branches : tout utilisateur ; modification de l'arbre : administrateurs seulement. */
export function orgRouter(pool: Pool) {
  const r = express.Router();

  const NODE_SQL = `SELECT n.id, n.parent_id, n.name, org_path(n.id) AS path,
      (SELECT max(c.depth) FROM org_closure c WHERE c.descendant_id = n.id) AS depth`;

  /** Mes branches et les branches auxquelles j'ai accès (les miennes et leurs descendantes), dans l'ordre de l'arbre. */
  r.get('/org/mine', wrap(async (req, res) => {
    const mine = (await pool.query(`${NODE_SQL} FROM user_org uo JOIN org_node n ON n.id = uo.node_id WHERE uo.user_id = $1 ORDER BY org_path(n.id)`, [req.auth!.id])).rows;
    const scope = await scopeNodes(pool, req);
    const access = (await pool.query(`${NODE_SQL} FROM org_node n WHERE ($1::uuid[] IS NULL OR n.id = ANY($1)) ORDER BY org_path(n.id)`, [scope])).rows;
    res.json({ mine, access });
  }));

  /** Arbre complet avec membres et volumes (administrateurs). */
  r.get('/org', wrap(async (req, res) => {
    requireAdmin(req);
    const { rows } = await pool.query(
      `${NODE_SQL},
        (SELECT count(*)::int FROM org_node k WHERE k.parent_id = n.id) AS children_count,
        (SELECT count(*)::int FROM visit v WHERE v.org_node_id = n.id AND v.deleted_at IS NULL) AS visits_count,
        COALESCE((SELECT json_agg(json_build_object('id', u.id, 'name', u.display_name, 'role', u.role) ORDER BY u.display_name)
                  FROM user_org uo JOIN app_user u ON u.id = uo.user_id WHERE uo.node_id = n.id), '[]'::json) AS members
       FROM org_node n ORDER BY org_path(n.id)`);
    res.json({ nodes: rows });
  }));

  const sameName = async (c: { query: Pool['query'] }, parent: string | null, nm: string, except?: string) =>
    (await c.query(`SELECT 1 FROM org_node WHERE parent_id IS NOT DISTINCT FROM $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)`, [parent, nm, except ?? null])).rows[0];

  r.post('/org/nodes', wrap(async (req, res) => {
    requireAdmin(req);
    // Sans parent (absent ou null) : une branche de premier niveau. Plusieurs branches de premier niveau sont permises (l'arbre est une forêt).
    const b = z.object({ name, parent_id: uuid.nullable().optional() }).strict().safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Nom requis');
    const parent = b.data.parent_id ?? null;
    const id = await tx(pool, async c => {
      if (parent && !(await c.query(`SELECT 1 FROM org_node WHERE id = $1`, [parent])).rows[0]) throw new HttpError(404, 'not_found', 'Branche parente inconnue');
      if (await sameName(c, parent, b.data.name)) throw new HttpError(409, 'name_taken', 'Une branche de ce nom existe déjà à cet endroit');
      const row = (await c.query(`INSERT INTO org_node(parent_id, name) VALUES ($1,$2) RETURNING id`, [parent, b.data.name])).rows[0];
      await c.query('SELECT rebuild_org()');
      await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id) VALUES ($1,'org_node_created','org_node',$2)`, [req.auth!.id, row.id]);
      return row.id as string;
    });
    res.status(201).json({ id });
  }));

  /** Renommer ou déplacer (changer de parent). Déplacer change les droits d'accès : les retraits sont transmis aux appareils. */
  r.patch('/org/nodes/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const b = z.object({ name: name.optional(), parent_id: uuid.nullable().optional() }).strict().safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    const id = req.params.id!;
    const out = await tx(pool, c => withRevocations(c, async () => {
      const cur = (await c.query(`SELECT * FROM org_node WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw new HttpError(404, 'not_found', 'Branche inconnue');
      // parent_id null : la branche devient une branche de premier niveau.
      const parent: string | null = b.data.parent_id !== undefined ? b.data.parent_id : cur.parent_id; const nm = b.data.name ?? cur.name;
      if (b.data.parent_id) {
        if (!(await c.query(`SELECT 1 FROM org_node WHERE id = $1`, [b.data.parent_id])).rows[0]) throw new HttpError(404, 'not_found', 'Branche parente inconnue');
        if ((await c.query(`SELECT 1 FROM org_closure WHERE ancestor_id = $1 AND descendant_id = $2`, [id, b.data.parent_id])).rows[0]) throw new HttpError(409, 'org_cycle', 'Une branche ne peut pas être déplacée sous elle-même ou sous une de ses descendantes');
      }
      if (await sameName(c, parent, nm, id)) throw new HttpError(409, 'name_taken', 'Une branche de ce nom existe déjà à cet endroit');
      await c.query(`UPDATE org_node SET name = $2, parent_id = $3, updated_at = now() WHERE id = $1`, [id, nm, parent]);
      await c.query('SELECT rebuild_org()');
      await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id, detail) VALUES ($1,'org_node_updated','org_node',$2,$3)`, [req.auth!.id, id, { fields: Object.keys(b.data) }]);
    }));
    res.json({ id, revoked: out.revoked });
  }));

  /** Supprimer une branche vide (de n'importe quel niveau, premier niveau compris) : sans sous-branche, sans membre, sans visite. */
  r.delete('/org/nodes/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const id = req.params.id!;
    await tx(pool, async c => {
      const cur = (await c.query(`SELECT parent_id FROM org_node WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) throw new HttpError(404, 'not_found', 'Branche inconnue');
      if ((await c.query(`SELECT 1 FROM org_node WHERE parent_id = $1`, [id])).rows[0]) throw new HttpError(409, 'has_children', "Cette branche a des sous-branches : supprimez-les ou déplacez-les d'abord");
      if ((await c.query(`SELECT 1 FROM user_org WHERE node_id = $1`, [id])).rows[0]) throw new HttpError(409, 'has_members', 'Des utilisateurs sont affectés à cette branche : affectez-les ailleurs d\'abord');
      if ((await c.query(`SELECT 1 FROM visit WHERE org_node_id = $1`, [id])).rows[0]) throw new HttpError(409, 'has_visits', 'Des visites appartiennent à cette branche : elle ne peut pas être supprimée');
      await c.query(`DELETE FROM org_node WHERE id = $1`, [id]);
      await c.query('SELECT rebuild_org()');
      await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id) VALUES ($1,'org_node_deleted','org_node',$2)`, [req.auth!.id, id]);
    });
    res.json({ id });
  }));

  return r;
}
