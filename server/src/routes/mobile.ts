import express from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { tx } from '../db.js';
import type { Config } from '../config.js';
import { HttpError, wrap } from '../errors.js';
import { requireAuth, signAccess, verifyPassword, sha256, randomToken, versionLt } from '../auth.js';
import { pull } from '../sync/pull.js';
import { push, pushSchema } from '../sync/push.js';

const loginSchema = z.object({
  email: z.string().email(), password: z.string().min(1),
  device: z.object({ device_id: z.string().uuid().optional(), platform: z.enum(['ios', 'android']), os_version: z.string().optional(), app_version: z.string() }),
});

export function mobileRouter(pool: Pool, cfg: Config) {
  const r = express.Router();
  const auth = requireAuth(pool, cfg, { checkVersion: true });

  async function issueTokens(userId: string, deviceId: string, isAdmin: boolean) {
    const refresh = randomToken();
    await pool.query(
      `INSERT INTO refresh_token(user_id, device_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4::int))`,
      [userId, deviceId, sha256(refresh), cfg.refreshTtlDays]);
    return { access_token: await signAccess(cfg, userId, deviceId, isAdmin), expires_in: cfg.accessTtlSeconds, refresh_token: refresh, device_id: deviceId };
  }

  r.post('/auth/login', wrap(async (req, res) => {
    const b = loginSchema.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    const { email, password, device } = b.data;
    if (versionLt(device.app_version, cfg.minAppVersion)) throw new HttpError(426, 'upgrade_required', `Version minimale : ${cfg.minAppVersion}`);
    const u = (await pool.query(`SELECT * FROM app_user WHERE email = $1`, [email])).rows[0];
    if (u?.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(423, 'account_locked', 'Compte verrouillé');
    const ok = u && u.status === 'active' && await verifyPassword(u.password_hash, password).catch(() => false);
    if (!ok) {
      if (u) {
        const fails = u.failed_logins + 1;
        await pool.query(`UPDATE app_user SET failed_logins = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE NULL END WHERE id = $1`,
          [u.id, fails, cfg.maxFailedLogins, cfg.lockMinutes]);
        await pool.query(`INSERT INTO audit_log(actor_user_id, action) VALUES ($1,'login_failed')`, [u.id]);
      }
      throw new HttpError(401, 'invalid_credentials', 'Identifiants incorrects');
    }
    await pool.query(`UPDATE app_user SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
    // Prototype : la double authentification n'est pas implémentée.
    let deviceId = device.device_id;
    const existing = deviceId && (await pool.query(`SELECT id FROM device WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [deviceId, u.id])).rows[0];
    if (!existing) {
      deviceId = (await pool.query(`INSERT INTO device(user_id, platform, os_version, app_version) VALUES ($1,$2,$3,$4) RETURNING id`,
        [u.id, device.platform, device.os_version ?? null, device.app_version])).rows[0].id;
    }
    await pool.query(`INSERT INTO audit_log(actor_user_id, action) VALUES ($1,'login')`, [u.id]);
    res.json(await issueTokens(u.id, deviceId!, u.is_admin));
  }));

  r.post('/auth/refresh', wrap(async (req, res) => {
    const token = z.object({ refresh_token: z.string() }).safeParse(req.body);
    if (!token.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    const out = await tx(pool, async c => {
      const t = (await c.query(`SELECT * FROM refresh_token WHERE token_hash = $1 FOR UPDATE`, [sha256(token.data.refresh_token)])).rows[0];
      if (!t) return { err: new HttpError(401, 'invalid_credentials', 'Jeton inconnu') };
      if (t.revoked_at) {
        // Jeton déjà utilisé : on suppose un vol et on coupe la session de l'appareil.
        await c.query(`UPDATE refresh_token SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, [t.device_id]);
        await c.query(`UPDATE device SET revoked_at = now() WHERE id = $1`, [t.device_id]);
        await c.query(`INSERT INTO audit_log(actor_user_id, action, entity, entity_id) VALUES ($1,'refresh_token_reuse','device',$2)`, [t.user_id, t.device_id]);
        return { err: new HttpError(401, 'invalid_credentials', 'Session révoquée') };
      }
      if (new Date(t.expires_at) < new Date()) return { err: new HttpError(401, 'token_expired', 'Jeton expiré') };
      const u = (await c.query(`SELECT id, is_admin, status FROM app_user WHERE id = $1`, [t.user_id])).rows[0];
      const d = (await c.query(`SELECT revoked_at FROM device WHERE id = $1`, [t.device_id])).rows[0];
      if (!u || u.status !== 'active' || d?.revoked_at) return { err: new HttpError(401, 'token_expired', 'Session révoquée') };
      await c.query(`UPDATE refresh_token SET revoked_at = now() WHERE id = $1`, [t.id]);
      return { u, deviceId: t.device_id as string };
    });
    if ('err' in out) throw out.err;
    res.json(await issueTokens(out.u.id, out.deviceId, out.u.is_admin));
  }));

  r.post('/auth/logout', auth, wrap(async (req, res) => {
    const { id, deviceId } = req.auth!;
    if (deviceId) {
      await pool.query(`UPDATE refresh_token SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL`, [deviceId]);
      await pool.query(`UPDATE device SET revoked_at = now() WHERE id = $1 AND user_id = $2`, [deviceId, id]);
    }
    res.status(204).end();
  }));

  r.get('/me', auth, wrap(async (req, res) => {
    const u = (await pool.query(`SELECT id, display_name, email, role, ui_language, dictation_language FROM app_user WHERE id = $1`, [req.auth!.id])).rows[0];
    const st = Object.fromEntries((await pool.query(`SELECT key, value FROM app_setting`)).rows.map(r => [r.key, r.value]));
    const langs = (await pool.query(`SELECT code FROM language WHERE enabled`)).rows.map(r => r.code);
    res.json({
      ...u, enabled_languages: langs,
      settings: { offline_window_days: Number(st.offline_window_days), audio_retention_days: Number(st.audio_retention_days) },
      min_app_version: cfg.minAppVersion, server_time: new Date().toISOString(),
    });
  }));

  r.get('/sync/pull', auth, wrap(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await pull(pool, cfg, req.auth!.id, req.query.cursor as string | undefined, limit));
  }));

  r.post('/sync/push', auth, wrap(async (req, res) => {
    const b = pushSchema.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Entre 1 et 200 opérations attendues');
    res.json({ results: await push(pool, req.auth!.id, req.auth!.deviceId, b.data.operations) });
  }));

  return r;
}
