import type { Request } from 'express';
import type { Pool } from '../../db.js';
import { HttpError } from '../../errors.js';

/**
 * Périmètre de l'utilisateur de l'application back : l'administrateur voit tout ; les autres, eux-mêmes et leurs subordonnés
 * (fermeture de la hiérarchie, qui contient l'utilisateur lui-même). `null` = aucun filtre.
 */
export async function scopeUsers(pool: Pool, req: Request): Promise<string[] | null> {
  const a = req.auth!;
  if (a.isAdmin) return null;
  const { rows } = await pool.query(`SELECT descendant_id FROM user_hierarchy WHERE ancestor_id = $1`, [a.id]);
  const ids = rows.map(r => r.descendant_id as string);
  return ids.includes(a.id) ? ids : [a.id, ...ids];
}

export const requireAdmin = (req: Request) => { if (!req.auth!.isAdmin) throw new HttpError(403, 'forbidden', 'Droit administrateur requis'); };

export const inScope = (scope: string[] | null, userId: string) => scope === null || scope.includes(userId);

/** Date AAAA-MM-JJ valide (sinon undefined). */
export const day = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);

export const pagination = (req: Request, max = 200) => ({
  limit: Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), max),
  offset: Math.max(Number(req.query.offset ?? 0) || 0, 0),
});
