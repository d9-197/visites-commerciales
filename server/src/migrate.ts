import { readFileSync, readdirSync } from 'node:fs';
import type { Pool } from './db.js';

const dir = new URL('../../db/', import.meta.url);

/**
 * Base vide : on charge le schéma complet (qui contient déjà toutes les migrations) et on les marque appliquées.
 * Base existante : on applique, dans l'ordre, les migrations de db/migrations/ pas encore enregistrées.
 */
export async function migrate(pool: Pool): Promise<string[]> {
  const files = readdirSync(new URL('migrations/', dir)).filter(f => f.endsWith('.sql')).sort();
  const fresh = !(await pool.query(`SELECT to_regclass('public.app_user') AS t`)).rows[0].t;
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(7243001)`);   // un seul démarrage à la fois
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    if (fresh) {
      await c.query(readFileSync(new URL('schema.sql', dir), 'utf8'));
      for (const f of files) await c.query(`INSERT INTO schema_migrations(id) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
    } else {
      const done = new Set((await c.query(`SELECT id FROM schema_migrations`)).rows.map(r => r.id));
      for (const f of files) {
        if (done.has(f)) continue;
        await c.query(readFileSync(new URL(`migrations/${f}`, dir), 'utf8'));
        await c.query(`INSERT INTO schema_migrations(id) VALUES ($1)`, [f]);
        applied.push(f);
      }
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  return applied;
}
