import express from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { tx } from '../db.js';
import type { Config } from '../config.js';
import { HttpError, wrap } from '../errors.js';
import { requireAuth, signAccess, verifyPassword, sha256, randomToken, versionLt } from '../auth.js';
import { pull } from '../sync/pull.js';
import { push, pushSchema } from '../sync/push.js';
import { AiError, type AiServices } from '../ai/index.js';

const loginSchema = z.object({
  email: z.string().email(), password: z.string().min(1),
  device: z.object({ device_id: z.string().uuid().optional(), platform: z.enum(['ios', 'android', 'web']), os_version: z.string().optional(), app_version: z.string() }),
});

export function mobileRouter(pool: Pool, cfg: Config, ai?: AiServices) {
  const r = express.Router();
  const aiCalls = new Map<string, number[]>();      // limitation de débit de l'IA, par utilisateur (en mémoire : une seule instance du back)
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

  /**
   * Synthèse par IA d'un compte rendu à partir de notes brutes. Rien n'est enregistré dans le compte rendu : la proposition est
   * renvoyée à l'application, qui la fait relire et valider par l'utilisateur. Contenu des notes : jamais journalisé.
   */
  r.post('/reports/:id/ai-proposals', auth, wrap(async (req, res) => {
    const b = z.object({ source_text: z.string().trim().min(1).max(20000), today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'source_text requis (20 000 caractères au plus)');
    if (!ai) throw new HttpError(503, 'ai_unavailable', 'Le service d\'IA n\'est pas configuré');
    const userId = req.auth!.id;

    const now = Date.now();
    const recent = (aiCalls.get(userId) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= Number(process.env.AI_RATE_PER_MIN ?? 10)) throw new HttpError(429, 'rate_limited', 'Trop de demandes de synthèse, réessayez dans une minute');
    aiCalls.set(userId, [...recent, now]);

    const rep = (await pool.query(`SELECT r.id, r.language, r.visit_id, r.status AS report_status, v.status AS visit_status, v.author_id FROM visit_report r JOIN visit v ON v.id = r.visit_id WHERE r.id = $1`, [req.params.id])).rows[0];
    const readable = rep && (await pool.query(`SELECT can_read_visit($1,$2) AS ok`, [userId, rep.visit_id])).rows[0].ok;
    if (!rep || !readable) throw new HttpError(404, 'not_found', 'Compte rendu inconnu');
    if (rep.author_id !== userId) throw new HttpError(403, 'forbidden', 'Réservé à l\'auteur de la visite');
    // Génération possible en fin de visite : visite en cours, ou terminée tant que le compte rendu n'est pas validé.
    if (!['in_progress', 'done'].includes(rep.visit_status) || rep.report_status === 'validated') {
      throw new HttpError(409, 'ai_not_available', rep.report_status === 'validated' ? 'Le compte rendu est validé' : 'La génération est possible une fois la visite commencée');
    }

    if (ai.prices) {   // plafond mensuel : appliqué seulement si les tarifs sont connus (sinon le coût est enregistré à 0)
      const q = (await pool.query(
        `SELECT COALESCE((SELECT sum(cost_cents) FROM ai_usage WHERE user_id = $1 AND created_at >= date_trunc('month', now())), 0) AS used,
                COALESCE((SELECT ai_budget_cents FROM app_user WHERE id = $1), (SELECT (value #>> '{}')::int FROM app_setting WHERE key = 'ai_monthly_budget_cents')) AS budget`, [userId])).rows[0];
      if (Number(q.used) >= Number(q.budget)) throw new HttpError(402, 'quota_exceeded', 'Plafond mensuel d\'IA atteint');
    }

    const glossary = (await pool.query(
      `SELECT term FROM glossary_term WHERE deleted_at IS NULL AND language = $1 AND (scope = 'global' OR user_id = $2) ORDER BY term LIMIT 50`, [rep.language, userId])).rows.map(x => x.term as string);
    const serverToday = new Date().toISOString().slice(0, 10);
    const close = (d: string) => Math.abs(new Date(d).getTime() - new Date(serverToday).getTime()) <= 2 * 86_400_000;
    const today = b.data.today && close(b.data.today) ? b.data.today : serverToday;     // date locale de l'appareil, à 2 jours près

    let result;
    try { result = await ai.service.structure({ sourceText: b.data.source_text, language: rep.language, today, glossary }); }
    catch (e) {
      if (e instanceof AiError) throw new HttpError(e.kind === 'unavailable' ? 503 : 502, e.kind === 'unavailable' ? 'ai_unavailable' : 'ai_failed', e.message);
      throw e;
    }
    const id = (await pool.query(
      `INSERT INTO ai_proposal(report_id, provider, model_version, source_text, proposal, checks, cost_cents) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [rep.id, result.provider, result.model, b.data.source_text, result.proposal, { warnings: result.warnings }, result.costCents])).rows[0].id;
    await pool.query(
      `INSERT INTO ai_usage(user_id, kind, provider, model, tokens_in, tokens_out, cost_cents) VALUES ($1,'llm',$2,$3,$4,$5,$6)`,
      [userId, result.provider, result.model, result.usage.tokensIn, result.usage.tokensOut, result.costCents]);
    res.json({ id, report_id: rep.id, source_text: b.data.source_text, proposal: result.proposal, warnings: result.warnings, provider: result.provider, model: result.model });
  }));

  const MAX_AUDIO_BYTES = Number(process.env.AUDIO_MAX_BYTES ?? 25 * 1024 * 1024);
  const MAX_AUDIO_SECONDS = 1800;

  /**
   * Transcription vocale d'une dictée pour une visite (Voxtral). L'audio traverse le back sans être conservé ; le texte est
   * renvoyé à l'application, qui le fait relire avant d'en faire une note. Corps : l'audio brut (Content-Type audio/*).
   */
  r.post('/visits/:id/transcriptions', auth, express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: MAX_AUDIO_BYTES }), wrap(async (req, res) => {
    const q = z.object({ language: z.enum(['fr', 'en', 'es', 'it', 'de', 'nl']).optional(), duration_s: z.coerce.number().min(0).max(MAX_AUDIO_SECONDS).optional() }).safeParse(req.query);
    if (!q.success) throw new HttpError(400, 'validation_failed', 'language ou duration_s invalide');
    if (!ai) throw new HttpError(503, 'ai_unavailable', 'La transcription vocale n\'est pas configurée');
    if (!/^(audio\/|video\/webm|application\/octet-stream)/i.test(req.header('content-type') ?? '')) throw new HttpError(400, 'validation_failed', 'Content-Type audio attendu');
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length < 100) throw new HttpError(400, 'validation_failed', 'Enregistrement vide ou trop court');
    const userId = req.auth!.id;

    const now = Date.now();
    const recent = (aiCalls.get(userId) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= Number(process.env.AI_RATE_PER_MIN ?? 10)) throw new HttpError(429, 'rate_limited', 'Trop de demandes, réessayez dans une minute');
    aiCalls.set(userId, [...recent, now]);

    const v = (await pool.query(`SELECT id, author_id FROM visit WHERE id = $1`, [req.params.id])).rows[0];
    const readable = v && (await pool.query(`SELECT can_read_visit($1,$2) AS ok`, [userId, req.params.id])).rows[0].ok;
    if (!v || !readable) throw new HttpError(404, 'not_found', 'Visite inconnue');
    if (v.author_id !== userId) throw new HttpError(403, 'forbidden', 'Réservé à l\'auteur de la visite');

    if (ai.prices || ai.transcribePrice !== undefined) {   // plafond mensuel commun à la transcription et à la synthèse, appliqué quand des tarifs sont connus
      const qt = (await pool.query(
        `SELECT COALESCE((SELECT sum(cost_cents) FROM ai_usage WHERE user_id = $1 AND created_at >= date_trunc('month', now())), 0) AS used,
                COALESCE((SELECT ai_budget_cents FROM app_user WHERE id = $1), (SELECT (value #>> '{}')::int FROM app_setting WHERE key = 'ai_monthly_budget_cents')) AS budget`, [userId])).rows[0];
      if (Number(qt.used) >= Number(qt.budget)) throw new HttpError(402, 'quota_exceeded', 'Plafond mensuel d\'IA atteint');
    }

    let result;
    try { result = await ai.transcriber.transcribe({ audio, mime: req.header('content-type')!, language: q.data.language }); }
    catch (e) {
      if (e instanceof AiError) throw new HttpError(e.kind === 'unavailable' ? 503 : 502, e.kind === 'unavailable' ? 'ai_unavailable' : 'ai_failed', e.message);
      throw e;
    }
    const seconds = result.audioSeconds ?? q.data.duration_s ?? null;   // durée annoncée par le fournisseur, sinon par l'application
    const costCents = seconds !== null && ai.transcribePrice !== undefined ? (seconds / 60) * ai.transcribePrice * 100 : 0;
    await pool.query(
      `INSERT INTO ai_usage(user_id, kind, provider, model, audio_seconds, cost_cents) VALUES ($1,'transcription',$2,$3,$4,$5)`,
      [userId, result.provider, result.model, seconds, costCents]);
    res.json({ text: result.text, language: result.language, duration_s: seconds });
  }));

  return r;
}
