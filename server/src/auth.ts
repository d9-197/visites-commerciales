import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { SignJWT, jwtVerify } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from './db.js';
import type { Config } from './config.js';
import { HttpError } from './errors.js';

export const hashPassword = (p: string) => hash(p);   // argon2id par défaut
export const verifyPassword = (h: string, p: string) => verify(h, p);
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

export interface AuthUser { id: string; deviceId: string | null; isAdmin: boolean; role: string }
declare global { namespace Express { interface Request { auth?: AuthUser } } }

const key = (cfg: Config) => new TextEncoder().encode(cfg.jwtSecret);

export async function signAccess(cfg: Config, userId: string, deviceId: string, isAdmin: boolean) {
  return new SignJWT({ did: deviceId, adm: isAdmin })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(userId)
    .setIssuedAt().setExpirationTime(`${cfg.accessTtlSeconds}s`).sign(key(cfg));
}

/** Compare deux versions « x.y.z ». */
export function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d !== 0) return d < 0; }
  return false;
}

export function requireAuth(pool: Pool, cfg: Config, opts: { admin?: boolean; checkVersion?: boolean } = {}) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
      if (!m) throw new HttpError(401, 'token_expired', 'Jeton absent');
      let payload;
      try { payload = (await jwtVerify(m[1]!, key(cfg))).payload; }
      catch { throw new HttpError(401, 'token_expired', 'Jeton invalide ou expiré'); }
      const { rows } = await pool.query(
        `SELECT u.id, u.role, u.is_admin, u.status, d.revoked_at AS dev_revoked
         FROM app_user u LEFT JOIN device d ON d.id = $2 WHERE u.id = $1`, [payload.sub, payload['did']]);
      const u = rows[0];
      if (!u || u.status !== 'active' || (payload['did'] && u.dev_revoked)) throw new HttpError(401, 'token_expired', 'Session révoquée');
      if (opts.admin && !u.is_admin) throw new HttpError(403, 'forbidden', 'Droit administrateur requis');
      if (opts.checkVersion) {
        const v = req.header('x-app-version');
        if (v && versionLt(v, cfg.minAppVersion)) throw new HttpError(426, 'upgrade_required', `Version minimale : ${cfg.minAppVersion}`);
      }
      req.auth = { id: u.id, deviceId: (payload['did'] as string) ?? null, isAdmin: u.is_admin, role: u.role };
      next();
    } catch (e) { next(e); }
  };
}

/** Compte de service du CRM : clé d'API en Bearer, comparée par empreinte. */
export function requireServiceKey(pool: Pool) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
      if (!m) throw new HttpError(401, 'invalid_credentials', 'Clé absente');
      const { rows } = await pool.query(
        `SELECT id FROM service_account WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
        [sha256(m[1]!)]);
      if (!rows[0]) throw new HttpError(401, 'invalid_credentials', 'Clé invalide');
      await pool.query(`INSERT INTO audit_log(actor_service_id, action, entity) VALUES ($1,'crm_read',$2)`, [rows[0].id, req.path]);
      next();
    } catch (e) { next(e); }
  };
}
