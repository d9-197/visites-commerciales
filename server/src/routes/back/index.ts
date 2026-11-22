import express from 'express';
import type { Pool } from '../../db.js';
import type { Config } from '../../config.js';
import { requireAuth } from '../../auth.js';
import { usersRouter } from './users.js';
import { crmRouter } from './crm.js';
import { reportsRouter } from './reports.js';
import { prepRouter } from './prep.js';
import { visitsRouter } from './visits.js';
import { requireAdmin } from './scope.js';

/** API de l'application back (PC) : /api/back/v1. Authentification par le même jeton que l'application mobile ; périmètre selon le rôle. */
export function backRouter(pool: Pool, cfg: Config) {
  const r = express.Router();
  r.use(requireAuth(pool, cfg));
  r.get('/me', (req, res, next) => {
    pool.query(`SELECT id, email, display_name, role, is_admin FROM app_user WHERE id = $1`, [req.auth!.id]).then(q => res.json(q.rows[0])).catch(next);
  });
  r.use(['/users', '/settings'], (req, _res, next) => { try { requireAdmin(req); next(); } catch (e) { next(e); } });
  r.use(usersRouter(pool)); r.use(crmRouter(pool)); r.use(reportsRouter(pool)); r.use(prepRouter(pool)); r.use(visitsRouter(pool));
  return r;
}
