import express from 'express';
import type { Pool } from '../db.js';
import type { Config } from '../config.js';
import { HttpError, wrap } from '../errors.js';
import { requireServiceKey } from '../auth.js';
import { decodeCursor, encodeCursor } from '../sync/pull.js';

// Lecture seule. S'appuie sur les vues crm_* : notes privées, audio, transcriptions et propositions IA n'y figurent pas.
const RESOURCES: Record<string, { view: string; tsCol: string }> = {
  visits: { view: 'crm_visit', tsCol: 'updated_at' },
  'visit-history': { view: 'crm_visit_history', tsCol: 'updated_at' },
  reports: { view: 'crm_report', tsCol: 'updated_at' },
  notes: { view: 'crm_note', tsCol: 'updated_at' },
  actions: { view: 'crm_action', tsCol: 'updated_at' },
};

export function crmRouter(pool: Pool, cfg: Config) {
  const r = express.Router();
  r.get('/health', (_req, res) => res.json({ status: 'ok' }));
  r.use(requireServiceKey(pool));
  for (const [path, { view }] of Object.entries(RESOURCES)) {
    r.get(`/${path}`, wrap(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 1000);
      if (!Number.isFinite(limit)) throw new HttpError(400, 'validation_failed', 'limit invalide');
      const includeDeleted = req.query.include_deleted !== 'false';
      const from = decodeCursor(req.query.cursor as string | undefined);
      const params: unknown[] = [from, limit + 1];
      let where = `seq > $1`;
      if (!req.query.cursor && req.query.updated_since) {
        const d = new Date(String(req.query.updated_since));
        if (Number.isNaN(d.getTime())) throw new HttpError(400, 'validation_failed', 'updated_since invalide');
        params.push(d.toISOString()); where += ` AND updated_at >= $${params.length}`;
      }
      if (!includeDeleted && ['visits', 'notes', 'actions'].includes(path)) where += ` AND deleted_at IS NULL`;
      if (typeof req.query.status === 'string') { params.push(req.query.status); where += ` AND status = $${params.length}`; }
      const { rows } = await pool.query(`SELECT * FROM ${view} WHERE ${where} ORDER BY seq LIMIT $2`, params);
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const maxSeq = items.length ? items[items.length - 1].seq : from;
      const next = hasMore ? maxSeq : (items.length ? Math.max(from, maxSeq - cfg.syncOverlap) : from);
      res.json({ items, next_cursor: encodeCursor(next), has_more: hasMore });
    }));
  }
  r.get('/visits/:id', wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT * FROM crm_visit WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'Visite inconnue');
    res.json(rows[0]);
  }));
  return r;
}
