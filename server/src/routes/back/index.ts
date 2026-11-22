import express from 'express';
import type { Pool } from '../../db.js';
import type { Config } from '../../config.js';
import { requireAuth } from '../../auth.js';
import { usersRouter } from './users.js';
import { crmRouter } from './crm.js';
import { reportsRouter } from './reports.js';
import { prepRouter } from './prep.js';
import { visitsRouter } from './visits.js';
import { orgRouter } from './org.js';
import { requireAdmin } from './scope.js';

/** API de l'application back (PC) : /api/back/v1. Authentification par le même jeton que l'application mobile ; périmètre selon le rôle. */
export function backRouter(pool: Pool, cfg: Config) {
  const r = express.Router();
  r.use(requireAuth(pool, cfg));
  r.get('/me', (req, res, next) => {
    pool.query(`SELECT u.id, u.email, u.display_name, u.role, u.is_admin,
      COALESCE((SELECT json_agg(json_build_object('id', n.id, 'name', n.name, 'path', org_path(n.id)) ORDER BY org_path(n.id)) FROM user_org uo JOIN org_node n ON n.id = uo.node_id WHERE uo.user_id = u.id), '[]'::json) AS nodes
      FROM app_user u WHERE u.id = $1`, [req.auth!.id]).then(q => res.json(q.rows[0])).catch(next);
  });
  r.use(['/users', '/settings'], (req, _res, next) => { try { requireAdmin(req); next(); } catch (e) { next(e); } });
  r.use(usersRouter(pool)); r.use(orgRouter(pool)); r.use(crmRouter(pool)); r.use(reportsRouter(pool)); r.use(prepRouter(pool)); r.use(visitsRouter(pool));
  return r;
}
