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

/**
 * Branches accessibles à l'utilisateur : ses nœuds et leurs descendants (administrateur : tout, `null`).
 * Une visite n'est visible dans l'application back que si son auteur est l'utilisateur lui-même ou si elle appartient à l'une de ces branches
 * (et, pour un commercial, `scopeUsers` le limite à lui-même).
 */
export async function scopeNodes(pool: Pool, req: Request): Promise<string[] | null> {
  if (req.auth!.isAdmin) return null;
  const { rows } = await pool.query(`SELECT DISTINCT c.descendant_id FROM user_org uo JOIN org_closure c ON c.ancestor_id = uo.node_id WHERE uo.user_id = $1`, [req.auth!.id]);
  return rows.map(r => r.descendant_id as string);
}

/** Sous-arbre d'un nœud (le nœud et ses descendants), limité aux branches accessibles ; `null` si le nœud est inconnu ou hors périmètre. */
export async function subtree(pool: Pool, nodeId: unknown, allowed: string[] | null): Promise<string[] | null> {
  if (typeof nodeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(nodeId)) return null;
  if (allowed !== null && !allowed.includes(nodeId)) return null;
  const ids = (await pool.query(`SELECT descendant_id FROM org_closure WHERE ancestor_id = $1`, [nodeId])).rows.map(r => r.descendant_id as string);
  return ids.length ? (allowed === null ? ids : ids.filter(i => allowed.includes(i))) : null;
}

/**
 * Auteurs dont on affiche les visites. Ne dépend NI du statut NI du rôle actuels de l'auteur : une visite d'un utilisateur désactivé, ou qui n'est plus
 * commercial, reste visible tant qu'elle appartient à une branche accessible. Un utilisateur précis (`uid`) n'est accepté que si l'on voit au moins une de ses visites.
 * Sans `uid` : tous les auteurs (administrateur, manager, directeur : la branche limite déjà) ou soi-même (commercial).
 */
export async function authorFilter(pool: Pool, req: Request, uid?: string): Promise<string[] | null> {
  const a = req.auth!;
  if (uid) {
    if (!/^[0-9a-f-]{36}$/i.test(uid)) throw new HttpError(404, 'not_found', 'Utilisateur hors de votre périmètre');
    if (!a.isAdmin && uid !== a.id) {
      const nodes = await scopeNodes(pool, req);
      const ok = (await pool.query(`SELECT 1 FROM visit WHERE author_id = $1 AND deleted_at IS NULL AND org_node_id = ANY($2::uuid[]) LIMIT 1`, [uid, nodes ?? []])).rows[0];
      if (!ok) throw new HttpError(404, 'not_found', 'Utilisateur hors de votre périmètre');
    }
    return [uid];
  }
  return a.isAdmin || a.role === 'manager' || a.role === 'directeur' ? null : [a.id];
}

export const requireAdmin = (req: Request) => { if (!req.auth!.isAdmin) throw new HttpError(403, 'forbidden', 'Droit administrateur requis'); };

export const inScope = (scope: string[] | null, userId: string) => scope === null || scope.includes(userId);

/** Date AAAA-MM-JJ valide (sinon undefined). */
export const day = (v: unknown): string | undefined => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);

export const pagination = (req: Request, max = 200) => ({
  limit: Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), max),
  offset: Math.max(Number(req.query.offset ?? 0) || 0, 0),
});
