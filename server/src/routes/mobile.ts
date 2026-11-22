import express from 'express';
import { z } from 'zod';
import type { Pool } from '../db.js';
import { tx } from '../db.js';
import type { Config } from '../config.js';
import { HttpError, wrap } from '../errors.js';
import { requireAuth, signAccess, verifyPassword, sha256, randomToken, versionLt } from '../auth.js';
import { pull } from '../sync/pull.js';
import { push, pushSchema } from '../sync/push.js';
import { AiError, type AiServices, type BriefReport } from '../ai/index.js';
import { reviewByRules } from '../ai/review-rules.js';
import type { MailService } from '../mail/index.js';
import { composeVisitEmail } from '../mail/compose.js';
import { DEFAULT_BRAND_NAME, type Brand } from '../brand.js';

const loginSchema = z.object({
  email: z.string().email(), password: z.string().min(1),
  device: z.object({ device_id: z.string().uuid().optional(), platform: z.enum(['ios', 'android', 'web']), os_version: z.string().optional(), app_version: z.string() }),
});

export function mobileRouter(pool: Pool, cfg: Config, ai?: AiServices, mail?: MailService, brand: Brand = { name: DEFAULT_BRAND_NAME }) {
  const r = express.Router();

  // Marque blanche (publique : l'écran de connexion l'affiche avant toute authentification).
  r.get('/brand', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({ name: brand.name, logo_path: brand.logo ? `/brand/logo?v=${brand.logo.version}` : null });
  });
  r.get('/brand/logo', (_req, res) => {
    if (!brand.logo) throw new HttpError(404, 'not_found', 'Aucun logo configuré');
    // Un SVG peut contenir des scripts : servi en image seulement, sans exécution (CSP), jamais interprété comme autre chose.
    res.set({ 'Content-Type': brand.logo.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'public, max-age=3600' }).send(brand.logo.data);
  });
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
    // Départements de l'utilisateur (une visite se crée dans l'un d'eux).
    const nodes = (await pool.query(`SELECT n.id, n.name, org_path(n.id) AS path FROM user_org uo JOIN org_node n ON n.id = uo.node_id WHERE uo.user_id = $1 ORDER BY org_path(n.id)`, [req.auth!.id])).rows;
    const st = Object.fromEntries((await pool.query(`SELECT key, value FROM app_setting`)).rows.map(r => [r.key, r.value]));
    const langs = (await pool.query(`SELECT code FROM language WHERE enabled`)).rows.map(r => r.code);
    res.json({
      ...u, nodes, enabled_languages: langs,
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

  // --- Brief avant visite et contrôle du compte rendu (IA) ---
  const rateOk = (userId: string) => {
    const now = Date.now(); const recent = (aiCalls.get(userId) ?? []).filter(t => now - t < 60_000);
    if (recent.length >= Number(process.env.AI_RATE_PER_MIN ?? 10)) return false;
    aiCalls.set(userId, [...recent, now]); return true;
  };
  const budgetOk = async (userId: string) => {
    if (!ai?.prices) return true;     // plafond appliqué seulement si les tarifs sont connus
    const q = (await pool.query(
      `SELECT COALESCE((SELECT sum(cost_cents) FROM ai_usage WHERE user_id = $1 AND created_at >= date_trunc('month', now())), 0) AS used,
              COALESCE((SELECT ai_budget_cents FROM app_user WHERE id = $1), (SELECT (value #>> '{}')::int FROM app_setting WHERE key = 'ai_monthly_budget_cents')) AS budget`, [userId])).rows[0];
    return Number(q.used) < Number(q.budget);
  };
  const logUsage = (userId: string, rs: { provider: string; model: string; usage: { tokensIn: number | null; tokensOut: number | null }; costCents: number }) =>
    pool.query(`INSERT INTO ai_usage(user_id, kind, provider, model, tokens_in, tokens_out, cost_cents) VALUES ($1,'llm',$2,$3,$4,$5,$6)`, [userId, rs.provider, rs.model, rs.usage.tokensIn, rs.usage.tokensOut, rs.costCents]);
  const resolveToday = (d?: string) => {
    const serverToday = new Date().toISOString().slice(0, 10);
    return d && Math.abs(new Date(d).getTime() - new Date(serverToday).getTime()) <= 2 * 86_400_000 ? d : serverToday;
  };
  const dateRe = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
  const aiHttpError = (e: unknown) => { if (e instanceof AiError) return new HttpError(e.kind === 'unavailable' ? 503 : 502, e.kind === 'unavailable' ? 'ai_unavailable' : 'ai_failed', e.message); return e; };

  /**
   * Brief avant visite : synthèse de l'historique du client (comptes rendus VALIDÉS que l'utilisateur peut lire, actions ouvertes qu'il peut lire, objectif et notes de
   * préparation de la visite). Jamais les notes internes, privées, ni les brouillons. Le nom du client n'est pas envoyé au fournisseur. Réservé à l'auteur de la visite.
   * Le résultat est conservé : tant que l'historique n'a pas changé, il est renvoyé sans nouvel appel (`refresh: true` force la régénération).
   */
  r.post('/visits/:id/ai-brief', auth, wrap(async (req, res) => {
    const b = z.object({ refresh: z.boolean().optional(), today: dateRe.optional() }).safeParse(req.body ?? {});
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    if (!ai) throw new HttpError(503, 'ai_unavailable', 'Le service d\'IA n\'est pas configuré');
    const userId = req.auth!.id;
    const v = (await pool.query(`SELECT id, company_id, author_id, status, objective, preparation_notes, planned_start FROM visit WHERE id = $1 AND deleted_at IS NULL`, [req.params.id])).rows[0];
    const readable = v && (await pool.query(`SELECT can_read_visit($1,$2) AS ok`, [userId, v.id])).rows[0].ok;
    if (!v || !readable) throw new HttpError(404, 'not_found', 'Visite inconnue');
    if (v.author_id !== userId) throw new HttpError(403, 'forbidden', 'Réservé à l\'auteur de la visite');
    if (!['planned', 'organized', 'in_progress'].includes(v.status)) throw new HttpError(409, 'ai_not_available', 'Le brief se prépare avant ou pendant la visite');
    const today = resolveToday(b.data.today);
    const lang = (await pool.query(`SELECT dictation_language FROM app_user WHERE id = $1`, [userId])).rows[0]?.dictation_language ?? 'fr';
    const reports: BriefReport[] = (await pool.query(
      `SELECT COALESCE(x.ended_at, x.started_at, x.planned_start) AS at, rp.opportunity_temperature AS temperature, rp.summary, rp.needs, rp.objections, rp.competitors, rp.decisions, rp.next_step
       FROM visit x JOIN visit_report rp ON rp.visit_id = x.id
       WHERE x.company_id = $1 AND x.id <> $2 AND x.deleted_at IS NULL AND rp.status = 'validated' AND can_read_visit($3, x.id)
       ORDER BY COALESCE(x.ended_at, x.started_at, x.planned_start) DESC NULLS LAST LIMIT 5`, [v.company_id, v.id, userId])).rows
      .map(x => ({ date: x.at ? new Date(x.at).toISOString().slice(0, 10) : null, temperature: x.temperature ?? null, summary: x.summary ?? '', needs: x.needs ?? '', objections: x.objections ?? '', competitors: x.competitors ?? '', decisions: x.decisions ?? '', next_step: x.next_step ?? '' }));
    const openActions = (await pool.query(
      `SELECT a.title, a.due_date::text AS due_date FROM action_item a WHERE a.company_id = $1 AND a.status = 'todo' AND can_read_action($2, a.id) ORDER BY a.due_date NULLS LAST, a.created_at LIMIT 15`, [v.company_id, userId])).rows
      .map(a => ({ title: a.title as string, due_date: (a.due_date as string | null) ?? null, late: !!a.due_date && a.due_date < today }));
    const objective = (v.objective as string | null)?.trim() || null; const prep = (v.preparation_notes as string | null)?.trim() || null;
    const plannedStart = v.planned_start ? new Date(v.planned_start).toISOString() : null;
    const sources = { reports: reports.length, actions: openActions.length };
    if (reports.length === 0 && openActions.length === 0 && !objective && !prep) {
      res.json({ visit_id: v.id, empty: true, brief: null, warnings: [], sources, cached: false });     // rien à synthétiser : aucun appel à l'IA
      return;
    }
    const hash = sha256(JSON.stringify({ lang, reports, openActions, objective, prep, plannedStart }));
    if (!b.data.refresh) {
      const c = (await pool.query(`SELECT brief, warnings, model, created_at FROM ai_brief WHERE visit_id = $1 AND user_id = $2 AND source_hash = $3`, [v.id, userId, hash])).rows[0];
      if (c) { res.json({ visit_id: v.id, empty: false, brief: c.brief, warnings: c.warnings, model: c.model, generated_at: c.created_at, sources, cached: true }); return; }
    }
    if (!rateOk(userId)) throw new HttpError(429, 'rate_limited', 'Trop de demandes d\'IA, réessayez dans une minute');
    if (!(await budgetOk(userId))) throw new HttpError(402, 'quota_exceeded', 'Plafond mensuel d\'IA atteint');
    const glossary = (await pool.query(`SELECT term FROM glossary_term WHERE deleted_at IS NULL AND language = $1 AND (scope = 'global' OR user_id = $2) ORDER BY term LIMIT 50`, [lang, userId])).rows.map(x => x.term as string);
    let result;
    try { result = await ai.service.brief({ language: lang, today, objective, preparationNotes: prep, plannedStart, reports, openActions, glossary }); } catch (e) { throw aiHttpError(e); }
    await pool.query(
      `INSERT INTO ai_brief(visit_id, user_id, source_hash, brief, warnings, model) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (visit_id, user_id) DO UPDATE SET source_hash = EXCLUDED.source_hash, brief = EXCLUDED.brief, warnings = EXCLUDED.warnings, model = EXCLUDED.model, created_at = now()`,
      [v.id, userId, hash, result.brief, JSON.stringify(result.warnings), result.model]);
    await logUsage(userId, result);
    res.json({ visit_id: v.id, empty: false, brief: result.brief, warnings: result.warnings, model: result.model, generated_at: new Date().toISOString(), sources, cached: false });
  }));

  const reviewBody = z.object({
    fields: z.object({ summary: z.string().max(5000).optional(), needs: z.string().max(5000).optional(), objections: z.string().max(5000).optional(),
      competitors: z.string().max(5000).optional(), decisions: z.string().max(5000).optional(), next_step: z.string().max(5000).optional() }).strict(),
    temperature: z.enum(['cold', 'warm', 'hot']).nullable().optional(),
    actions: z.array(z.object({ title: z.string().trim().min(1).max(200), due_date: dateRe.nullable().optional() })).max(30).optional(),
    no_action: z.boolean().optional(), notes_text: z.string().max(20000).optional(), today: dateRe.optional(),
  }).strict();

  /**
   * Contrôle d'un compte rendu avant validation (brouillon envoyé par l'application : il n'est pas encore forcément synchronisé).
   * Règles locales gratuites (toujours) + relecture par l'IA (si disponible). Ne bloque jamais la validation. Notes de la visite : jamais les notes internes ni privées.
   * `ai.status` : ok, skipped (rien à relire), unavailable (IA non configurée), rate_limited, quota, failed.
   */
  r.post('/reports/:id/ai-review', auth, wrap(async (req, res) => {
    const b = reviewBody.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Compte rendu à contrôler invalide');
    const userId = req.auth!.id;
    const rep = (await pool.query(`SELECT r.id, r.language, r.visit_id, r.status AS report_status, v.status AS visit_status, v.author_id FROM visit_report r JOIN visit v ON v.id = r.visit_id WHERE r.id = $1`, [req.params.id])).rows[0];
    const readable = rep && (await pool.query(`SELECT can_read_visit($1,$2) AS ok`, [userId, rep.visit_id])).rows[0].ok;
    if (!rep || !readable) throw new HttpError(404, 'not_found', 'Compte rendu inconnu');
    if (rep.author_id !== userId) throw new HttpError(403, 'forbidden', 'Réservé à l\'auteur de la visite');
    if (rep.report_status === 'validated' || !['in_progress', 'done'].includes(rep.visit_status)) throw new HttpError(409, 'ai_not_available', 'Le compte rendu est validé ou la visite n\'est pas en fin de rendez-vous');
    const f = b.data.fields;
    const input = {
      language: rep.language as string, today: resolveToday(b.data.today),
      fields: { summary: f.summary ?? '', needs: f.needs ?? '', objections: f.objections ?? '', competitors: f.competitors ?? '', decisions: f.decisions ?? '', next_step: f.next_step ?? '' },
      temperature: b.data.temperature ?? null, actions: (b.data.actions ?? []).map(a => ({ title: a.title, due_date: a.due_date ?? null })), noAction: !!b.data.no_action, notes: b.data.notes_text ?? '',
    };
    const issues = reviewByRules(input);
    let status: 'ok' | 'skipped' | 'unavailable' | 'rate_limited' | 'quota' | 'failed' = 'ok'; let model: string | undefined;
    if (!ai) status = 'unavailable';
    else if (!input.fields.summary.trim() && !input.notes.trim()) status = 'skipped';
    else if (!rateOk(userId)) status = 'rate_limited';
    else if (!(await budgetOk(userId))) status = 'quota';
    else {
      try { const rs = await ai.service.review(input); issues.push(...rs.issues); model = rs.model; await logUsage(userId, rs); }
      catch (e) { if (e instanceof AiError) status = 'failed'; else throw e; }
    }
    issues.sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'warning' ? -1 : 1));
    res.json({ report_id: rep.id, issues, ai: { status, ...(model ? { model } : {}) } });
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

  /**
   * E-mail d'une visite : destinataires = l'utilisateur lui-même et sa hiérarchie (supérieurs), jamais le client.
   * Contenu au choix : compte rendu (validé seulement), actions, notes durant visite. Les notes internes et privées ne sont jamais envoyées.
   */
  async function emailContext(userId: string, visitId: string) {
    const v = (await pool.query(`SELECT v.*, c.name AS company_name FROM visit v JOIN company c ON c.id = v.company_id WHERE v.id = $1`, [visitId])).rows[0];
    const readable = v && (await pool.query(`SELECT can_read_visit($1,$2) AS ok`, [userId, visitId])).rows[0].ok;
    if (!v || !readable || v.deleted_at) throw new HttpError(404, 'not_found', 'Visite inconnue');
    const me = (await pool.query(`SELECT id, email, display_name, role FROM app_user WHERE id = $1`, [userId])).rows[0];
    const chain = (await pool.query(
      `SELECT u.id, u.email, u.display_name, u.role FROM user_hierarchy h JOIN app_user u ON u.id = h.ancestor_id
       WHERE h.descendant_id = $1 AND h.ancestor_id <> $1 AND u.status = 'active' AND can_read_visit(u.id, $2) ORDER BY h.depth`, [userId, visitId])).rows;
    return { v, me, chain };
  }

  r.get('/visits/:id/email-options', auth, wrap(async (req, res) => {
    const { v, me, chain } = await emailContext(req.auth!.id, req.params.id);
    const report = (await pool.query(`SELECT 1 FROM visit_report WHERE visit_id = $1 AND status = 'validated'`, [v.id])).rows[0];
    const actions = (await pool.query(`SELECT count(*)::int AS n FROM action_item WHERE visit_id = $1 AND status <> 'cancelled'`, [v.id])).rows[0].n;
    const notes = (await pool.query(`SELECT count(*)::int AS n FROM visit_note WHERE visit_id = $1 AND deleted_at IS NULL AND coalesce(body, '') <> ''`, [v.id])).rows[0].n;
    res.json({
      configured: !!mail,
      recipients: [{ id: me.id, name: me.display_name, email: me.email, role: me.role, kind: 'self' }, ...chain.map(u => ({ id: u.id, name: u.display_name, email: u.email, role: u.role, kind: 'hierarchy' }))],
      parts: { report: !!report, actions, notes },
    });
  }));

  r.post('/visits/:id/email', auth, wrap(async (req, res) => {
    const body = z.object({
      recipient_ids: z.array(z.string().uuid()).min(1).max(10), parts: z.array(z.enum(['report', 'actions', 'notes'])).min(1),
      message: z.string().max(2000).optional(),
    }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'validation_failed', 'Destinataires et contenu requis');
    if (!mail) throw new HttpError(503, 'email_unavailable', "L'envoi d'e-mail n'est pas configuré");
    const userId = req.auth!.id;
    const { v, me, chain } = await emailContext(userId, req.params.id);
    const allowed = new Map([[me.id, me], ...chain.map(u => [u.id, u] as const)]);
    const recipients = [...new Set(body.data.recipient_ids)].map(id => allowed.get(id));
    if (recipients.some(x => !x)) throw new HttpError(403, 'forbidden', 'Destinataire non autorisé : vous-même ou votre hiérarchie seulement');
    const parts = [...new Set(body.data.parts)];

    const limit = Number(process.env.EMAIL_RATE_PER_HOUR ?? 20);
    const sent = (await pool.query(`SELECT count(*)::int AS n FROM visit_email WHERE sender_id = $1 AND created_at > now() - interval '1 hour'`, [userId])).rows[0].n;
    if (sent >= limit) throw new HttpError(429, 'rate_limited', "Trop d'envois, réessayez plus tard");

    const input: Parameters<typeof composeVisitEmail>[0] = {
      company: v.company_name, plannedStart: v.planned_start?.toISOString() ?? null, startedAt: v.started_at?.toISOString() ?? null, endedAt: v.ended_at?.toISOString() ?? null,
      location: v.location_text, senderName: me.display_name, message: body.data.message, brandName: brand.name,
    };
    if (parts.includes('report')) {
      const rep = (await pool.query(`SELECT summary, needs, objections, competitors, decisions, next_step, opportunity_temperature FROM visit_report WHERE visit_id = $1 AND status = 'validated'`, [v.id])).rows[0];
      if (!rep) throw new HttpError(409, 'report_not_validated', "Le compte rendu n'est pas validé : il ne peut pas être envoyé");
      input.report = rep;
    }
    if (parts.includes('actions')) input.actions = (await pool.query(`SELECT title, due_date::text AS due_date, status FROM action_item WHERE visit_id = $1 AND status <> 'cancelled' ORDER BY due_date NULLS LAST, created_at`, [v.id])).rows;
    if (parts.includes('notes')) input.notes = (await pool.query(`SELECT body FROM visit_note WHERE visit_id = $1 AND deleted_at IS NULL AND coalesce(body, '') <> '' ORDER BY noted_at, created_at`, [v.id])).rows;

    const to = recipients.map(x => x!.email as string);
    const msg = composeVisitEmail(input);
    try { await mail.send({ to, replyTo: me.email, ...msg }); }
    catch (e) {
      await pool.query(`INSERT INTO visit_email(visit_id, sender_id, recipients, parts, status, error) VALUES ($1,$2,$3,$4,'failed',$5)`, [v.id, userId, to, parts, String((e as Error).message).slice(0, 300)]);
      console.error(`[email] envoi refusé : ${String((e as Error).message).slice(0, 200)}`);
      throw new HttpError(502, 'email_failed', "L'e-mail n'a pas pu être envoyé");
    }
    await pool.query(`INSERT INTO visit_email(visit_id, sender_id, recipients, parts, status) VALUES ($1,$2,$3,$4,'sent')`, [v.id, userId, to, parts]);
    res.json({ sent_to: to, parts });
  }));

  return r;
}
