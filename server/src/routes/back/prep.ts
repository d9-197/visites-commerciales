import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from '../../db.js';
import { tx } from '../../db.js';
import { HttpError, wrap } from '../../errors.js';
import { VISIT_HISTORY_FIELDS, VISIT_LATE_GRACE_MINUTES } from '@visites/sync-core';
import { withRevocations } from '../../sync/revocations.js';
import { scopeUsers, scopeNodes, inScope, authorFilter, day } from './scope.js';

const uuid = z.string().uuid();
const ts = z.string().datetime({ offset: true });
const text = (n: number) => z.string().trim().max(n).nullable().optional();
/** Liste d'identifiants séparés par des virgules (filtre à choix multiple) ; null si vide. */
export const csvIds = (v: unknown): string[] | null => {
  const ids = String(v ?? '').split(',').map(x => x.trim()).filter(x => /^[0-9a-f-]{36}$/i.test(x));
  return ids.length ? ids : null;
};
const address = (c: Record<string, any>) => [c.address_line, [c.postal_code, c.city].filter(Boolean).join(' '), c.country].filter(Boolean).join(', ');

/** Préparation des visites : suggestions de clients, fiche de préparation, planification pour les commerciaux. */
export function prepRouter(pool: Pool) {
  const r = express.Router();

  /** Le client est-il accessible à l'utilisateur ? (administrateur : tout ; sinon affecté à lui ou à un subordonné.) */
  async function companyAccess(req: express.Request, companyId: string) {
    const c = (await pool.query(`SELECT id, crm_id, name, address_line, postal_code, city, country, sector, status FROM company WHERE id = $1 AND deleted_at IS NULL`, [companyId])).rows[0];
    const ok = c && (req.auth!.isAdmin || (await pool.query(`SELECT can_read_company($1,$2) AS ok`, [req.auth!.id, companyId])).rows[0].ok);
    if (!ok) throw new HttpError(404, 'not_found', 'Client inconnu');
    return c;
  }

  /** Recherche de clients accessibles (pour planifier une visite) : l'administrateur voit tout, les autres les clients affectés à leur périmètre. */
  r.get('/prep/companies', wrap(async (req, res) => {
    const scope = await scopeUsers(pool, req);
    const q = String(req.query.q ?? '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 30) || 30, 1), 1000);     // la liste complète (filtres à choix multiple) : jusqu'à 1000
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.city, c.sector FROM company c WHERE c.status = 'active' AND c.deleted_at IS NULL AND ($2 = '' OR c.name ILIKE '%'||$2||'%' OR c.city ILIKE '%'||$2||'%')
         AND EXISTS (SELECT 1 FROM company_assignment a WHERE a.company_id = c.id AND a.removed_at IS NULL AND ($1::uuid[] IS NULL OR a.user_id = ANY($1)))
       ORDER BY c.name LIMIT $3`, [scope, q, limit]);
    res.json({ companies: rows });
  }));

  r.get('/prep/commerciaux', wrap(async (req, res) => {
    const scope = await scopeUsers(pool, req);
    const company = typeof req.query.company_id === 'string' && z.string().uuid().safeParse(req.query.company_id).success ? req.query.company_id : null;
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name AS name, u.email,
              ($2::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM company_assignment a WHERE a.company_id = $2 AND a.user_id = u.id AND a.removed_at IS NULL)) AS assigned
       FROM app_user u WHERE u.role = 'commercial' AND u.status = 'active' AND ($1::uuid[] IS NULL OR u.id = ANY($1)) ORDER BY assigned DESC, u.display_name`, [scope, company]);
    res.json({ users: rows });
  }));

  /**
   * Personnes à qui une visite peut être attribuée : commerciaux, managers et directeurs actifs qui ont accès à la branche de la visite et peuvent lire le client.
   * Pour un planificateur non administrateur : seulement lui-même et les personnes de son périmètre. `assigned` : le client est affecté à la personne.
   */
  async function assignees(req: express.Request, companyId: string, nodeIds: string[] | null) {
    const scope = await scopeUsers(pool, req);
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name AS name, u.email, u.role,
         EXISTS (SELECT 1 FROM company_assignment a WHERE a.company_id = $1 AND a.user_id = u.id AND a.removed_at IS NULL) AS assigned
       FROM app_user u
       WHERE u.status = 'active' AND u.role IN ('commercial', 'manager', 'directeur') AND ($2::uuid[] IS NULL OR u.id = ANY($2))
         AND can_read_company(u.id, $1) AND ($3::uuid[] IS NULL OR EXISTS (SELECT 1 FROM unnest($3::uuid[]) n WHERE org_access(u.id, n)))
       ORDER BY assigned DESC, u.display_name`, [companyId, scope, nodeIds]);
    return rows;
  }

  r.get('/prep/assignees', wrap(async (req, res) => {
    let companyId = typeof req.query.company_id === 'string' ? req.query.company_id : '';
    let nodeIds: string[] | null = typeof req.query.node_id === 'string' && req.query.node_id ? [req.query.node_id] : null;
    if (typeof req.query.visit_id === 'string' && req.query.visit_id) {
      const v = (await pool.query(`SELECT company_id, org_node_id FROM visit WHERE id = $1 AND deleted_at IS NULL AND ($2::boolean OR can_read_visit($3, id))`, [req.query.visit_id, req.auth!.isAdmin, req.auth!.id])).rows[0];
      if (!v) throw new HttpError(404, 'not_found', 'Visite inconnue');
      companyId = v.company_id; nodeIds = [v.org_node_id];
    }
    if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw new HttpError(400, 'validation_failed', 'company_id ou visit_id requis');
    await companyAccess(req, companyId);
    res.json({ users: await assignees(req, companyId, nodeIds) });
  }));

  /**
   * Clients à visiter : jamais visités, sans visite depuis N jours, actions en retard, opportunité chaude sans visite prévue.
   * Par défaut, un client qui a déjà une visite à venir n'apparaît pas (il est « préparé »).
   */
  r.get('/prep/suggestions', wrap(async (req, res) => {
    const scope = await scopeUsers(pool, req);
    const uid = typeof req.query.user_id === 'string' ? req.query.user_id : undefined;
    if (uid && !inScope(scope, uid)) throw new HttpError(404, 'not_found', 'Utilisateur hors de votre périmètre');
    const days = Math.min(Math.max(Number(req.query.days ?? 60) || 60, 7), 730);
    const includePlanned = req.query.include_planned === 'true';
    const ids = uid ? [uid] : scope;
    const nodes = await scopeNodes(pool, req);
    const companyIds = csvIds(req.query.company_ids);
    const NV = `($2::uuid[] IS NULL OR v.org_node_id = ANY($2) OR v.author_id = $3::uuid)`;   // visites de mes branches (ou les miennes)
    const { rows } = await pool.query(
      `WITH cs AS (
         SELECT c.id, c.name, c.city, c.sector FROM company c
         WHERE c.status = 'active' AND c.deleted_at IS NULL AND ($4::uuid[] IS NULL OR c.id = ANY($4)) AND EXISTS (SELECT 1 FROM company_assignment a WHERE a.company_id = c.id AND a.removed_at IS NULL AND ($1::uuid[] IS NULL OR a.user_id = ANY($1)))
       )
       SELECT cs.id, cs.name, cs.city, cs.sector,
         (SELECT max(COALESCE(v.ended_at, v.started_at, v.planned_start)) FROM visit v WHERE v.company_id = cs.id AND v.deleted_at IS NULL AND ${NV} AND v.status IN ('done','validated','in_progress')) AS last_visit_at,
         (SELECT min(v.planned_start) FROM visit v WHERE v.company_id = cs.id AND v.deleted_at IS NULL AND ${NV} AND v.status IN ('planned','organized') AND v.planned_start >= now() - interval '1 day') AS next_visit_at,
         (SELECT count(*)::int FROM action_item x WHERE x.company_id = cs.id AND x.status = 'todo' AND x.due_date < current_date AND (x.visit_id IS NULL OR EXISTS (SELECT 1 FROM visit v WHERE v.id = x.visit_id AND ${NV}))) AS late_actions,
         (SELECT count(*)::int FROM action_item x WHERE x.company_id = cs.id AND x.status = 'todo' AND (x.visit_id IS NULL OR EXISTS (SELECT 1 FROM visit v WHERE v.id = x.visit_id AND ${NV}))) AS open_actions,
         (SELECT rp.opportunity_temperature FROM visit_report rp JOIN visit v ON v.id = rp.visit_id WHERE v.company_id = cs.id AND rp.status = 'validated' AND v.deleted_at IS NULL AND ${NV}
            ORDER BY COALESCE(v.ended_at, v.started_at, v.planned_start) DESC NULLS LAST LIMIT 1) AS last_temperature,
         (SELECT string_agg(u.display_name, ', ' ORDER BY u.display_name) FROM company_assignment a JOIN app_user u ON u.id = a.user_id
            WHERE a.company_id = cs.id AND a.removed_at IS NULL AND ($1::uuid[] IS NULL OR u.id = ANY($1))) AS commerciaux
       FROM cs`, [ids, nodes, req.auth!.id, companyIds]);
    const now = Date.now();
    const out = rows.map(c => {
      const sinceDays = c.last_visit_at ? Math.floor((now - new Date(c.last_visit_at).getTime()) / 86400000) : null;
      const reasons: string[] = [];
      if (sinceDays === null) reasons.push('never_visited');
      else if (sinceDays >= days) reasons.push('stale');
      if (c.late_actions > 0) reasons.push('late_actions');
      if (c.last_temperature === 'hot' && !c.next_visit_at) reasons.push('hot_no_followup');
      const score = (reasons.includes('hot_no_followup') ? 40 : 0) + (c.late_actions > 0 ? 30 + Math.min(c.late_actions, 5) * 2 : 0) + (sinceDays === null ? 25 : sinceDays >= days ? Math.min(sinceDays, 365) / 10 : 0);
      return { ...c, days_since_last_visit: sinceDays, reasons, score: Math.round(score * 10) / 10 };
    }).filter(c => c.reasons.length > 0 && (includePlanned || !c.next_visit_at)).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr')).slice(0, 200);
    res.json({ days, suggestions: out });
  }));

  /** Fiche de préparation d'un client : informations, contacts, dernières visites (compte rendu si le viewer peut le lire), actions ouvertes, points à aborder. */
  r.get('/prep/companies/:id', wrap(async (req, res) => {
    const company = await companyAccess(req, req.params.id!);
    const viewer = req.auth!;
    const contacts = (await pool.query(`SELECT id, full_name, job_title, phone, email FROM contact WHERE company_id = $1 AND deleted_at IS NULL AND active ORDER BY full_name`, [company.id])).rows;
    const commerciaux = (await pool.query(`SELECT u.id, u.display_name AS name FROM company_assignment a JOIN app_user u ON u.id = a.user_id WHERE a.company_id = $1 AND a.removed_at IS NULL ORDER BY u.display_name`, [company.id])).rows;
    const visits = (await pool.query(
      `SELECT v.id, v.status, v.planned_start, v.started_at, v.ended_at, v.objective, v.preparation_notes, COALESCE(u.display_name, 'Non attribuée') AS author, v.author_id, v.location_text, v.org_node_id,
              ($2::boolean OR can_read_visit($3, v.id)) AS readable
       FROM visit v LEFT JOIN app_user u ON u.id = v.author_id WHERE v.company_id = $1 AND v.deleted_at IS NULL AND v.status <> 'deleted'
         AND ($4::uuid[] IS NULL OR v.org_node_id = ANY($4) OR v.author_id = $3)
       ORDER BY (v.status IN ('planned','organized')) DESC, COALESCE(v.ended_at, v.started_at, v.planned_start) DESC NULLS LAST LIMIT 12`, [company.id, viewer.isAdmin, viewer.id, await scopeNodes(pool, req)])).rows;
    const reports = visits.length ? (await pool.query(
      `SELECT visit_id, summary, needs, objections, competitors, decisions, next_step, opportunity_temperature, status FROM visit_report WHERE visit_id = ANY($1::uuid[]) AND status = 'validated'`,
      [visits.filter(v => v.readable).map(v => v.id)])).rows : [];
    const actions = (await pool.query(
      `SELECT x.id, x.title, x.due_date::text AS due_date, x.status, COALESCE(x.status = 'todo' AND x.due_date < current_date, false) AS late, u.display_name AS owner, x.visit_id
       FROM action_item x JOIN app_user u ON u.id = x.owner_id WHERE x.company_id = $1 AND x.status = 'todo' AND ($2::boolean OR can_read_action($3, x.id)) ORDER BY x.due_date NULLS LAST`, [company.id, viewer.isAdmin, viewer.id])).rows;
    const shown = visits.map(v => ({ id: v.id, author_id: v.author_id, location_text: v.location_text, org_node_id: v.org_node_id, late: isLate(v), status: v.status, planned_start: v.planned_start, started_at: v.started_at, ended_at: v.ended_at, author: v.author, objective: v.objective, preparation_notes: v.preparation_notes,
      report: v.readable ? reports.find(x => x.visit_id === v.id) ?? null : null, report_hidden: !v.readable }));
    const last = shown.find(v => v.report);
    const agenda: { kind: string; text: string }[] = [];
    if (last?.report?.next_step) agenda.push({ kind: 'next_step', text: `Prochaine étape du dernier compte rendu : ${last.report.next_step}` });
    if (last?.report?.objections) agenda.push({ kind: 'objections', text: `Objections à lever : ${last.report.objections}` });
    if (last?.report?.decisions) agenda.push({ kind: 'decisions', text: `Décisions à suivre : ${last.report.decisions}` });
    for (const a of actions.slice(0, 8)) agenda.push({ kind: 'action', text: `${a.late ? '(en retard) ' : ''}${a.title}${a.due_date ? ` — échéance ${a.due_date}` : ''}` });
    res.json({ company: { ...company, address: address(company) }, contacts, commerciaux, visits: shown, open_actions: actions, agenda });
  }));

  const isLate = (v: Record<string, any>) => ['planned', 'organized'].includes(v.status) && !!v.planned_start && new Date(v.planned_start).getTime() + VISIT_LATE_GRACE_MINUTES * 60_000 < Date.now();

  /**
   * Visites en préparation : « à organiser avec le client » et « organisées », de vos branches, qu'elles soient attribuées ou non, **en retard comprises**.
   * Filtres : `status`, `user_id` (une personne, ou `none` = non attribuées), `company_ids` (plusieurs clients), `late=true`, `from`/`to` (sur la date prévue ; les visites sans date restent listées).
   */
  r.get('/prep/visits', wrap(async (req, res) => {
    const A = req.auth!;
    const uidRaw = typeof req.query.user_id === 'string' ? req.query.user_id : undefined;
    const unassigned = uidRaw === 'none';
    const authors = unassigned ? null : await authorFilter(pool, req, uidRaw);   // indépendant du statut et du rôle actuels de l'auteur
    const from = day(req.query.from) ?? null; const to = day(req.query.to) ?? null;
    const status = ['planned', 'organized'].includes(String(req.query.status)) ? String(req.query.status) : null;
    const { rows } = await pool.query(
      `SELECT v.id, v.company_id, c.name AS company, v.author_id, COALESCE(u.display_name, 'Non attribuée') AS author, u.role AS author_role, u.status AS author_status,
              v.org_node_id, org_path(v.org_node_id) AS org_path, cb.display_name AS created_by_name, v.status, v.planned_start, v.location_text, v.objective, v.preparation_notes, v.version,
              (v.planned_start IS NOT NULL AND v.planned_start + make_interval(mins => $9::int) < now()) AS late
       FROM visit v JOIN company c ON c.id = v.company_id LEFT JOIN app_user u ON u.id = v.author_id LEFT JOIN app_user cb ON cb.id = v.created_by
       WHERE v.deleted_at IS NULL AND v.status IN ('planned','organized') AND ($1::boolean OR can_read_visit($2, v.id))
         AND ($3::uuid[] IS NULL OR v.author_id = ANY($3)) AND (NOT $4::boolean OR v.author_id IS NULL)
         AND ($5::text IS NULL OR v.status = $5) AND ($6::uuid[] IS NULL OR v.company_id = ANY($6))
         AND ($7::date IS NULL OR v.planned_start IS NULL OR v.planned_start >= $7::date) AND ($8::date IS NULL OR v.planned_start IS NULL OR v.planned_start < $8::date + 1)
         AND (NOT $10::boolean OR (v.planned_start IS NOT NULL AND v.planned_start + make_interval(mins => $9::int) < now()))
       ORDER BY v.planned_start NULLS FIRST LIMIT 1000`,
      [A.isAdmin, A.id, authors, unassigned, status, csvIds(req.query.company_ids), from, to, VISIT_LATE_GRACE_MINUTES, req.query.late === 'true']);
    res.json({ visits: rows, late_count: rows.filter(v => v.late).length });
  }));

  const create = z.object({ company_id: uuid, user_id: uuid.nullable().optional(), node_id: uuid.optional(), planned_start: ts.nullable().optional(), location_text: text(500), objective: text(2000), preparation_notes: text(5000) }).strict();

  /**
   * Préparer une visite : avec ou sans commercial (attribuée ou non), avec ou sans date. Attribuée à un commercial (ou à un directeur, ou à un manager),
   * elle arrive dans son application à la prochaine synchronisation ; non attribuée, elle reste visible des managers et directeurs de sa branche, qui l'attribuent ensuite.
   */
  r.post('/prep/visits', wrap(async (req, res) => {
    const b = create.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const d = b.data; const A = req.auth!; const scope = await scopeUsers(pool, req);
    const supervisor = A.isAdmin || A.role === 'manager' || A.role === 'directeur';
    const userId = d.user_id === undefined && !supervisor ? A.id : d.user_id ?? null;      // un commercial prépare pour lui-même
    if (userId === null && !supervisor) throw new HttpError(403, 'forbidden', 'Seuls les managers, directeurs et administrateurs préparent une visite non attribuée');
    if (userId && !inScope(scope, userId)) throw new HttpError(403, 'forbidden', 'Vous ne pouvez préparer que pour vous-même ou votre équipe');
    const company = await companyAccess(req, d.company_id);
    const allowed = await scopeNodes(pool, req);
    let candidates: { id: string; path: string }[];
    if (userId) {
      const who = (await assignees(req, company.id, null)).find(u => u.id === userId);
      if (!who) throw new HttpError(409, 'invalid_author', "Cette personne ne peut pas se voir attribuer la visite (compte inactif, ou client hors de son périmètre)");
      // ses propres branches communes avec vous ; à défaut, les branches de sa juridiction (directeur au-dessus de l'agence)
      const own = (await pool.query(`SELECT n.id, org_path(n.id) AS path FROM user_org uo JOIN org_node n ON n.id = uo.node_id WHERE uo.user_id = $1 ORDER BY org_path(n.id)`, [userId])).rows.filter(n => allowed === null || allowed.includes(n.id));
      candidates = own.length ? own : (await pool.query(`SELECT n.id, org_path(n.id) AS path FROM org_node n WHERE org_access($1, n.id) AND ($2::uuid[] IS NULL OR n.id = ANY($2)) ORDER BY org_path(n.id)`, [userId, allowed])).rows;
    } else {
      candidates = (await pool.query(`SELECT n.id, org_path(n.id) AS path FROM org_node n WHERE ($1::uuid[] IS NULL OR n.id = ANY($1)) ORDER BY org_path(n.id)`, [allowed])).rows;
    }
    if (candidates.length === 0) throw new HttpError(409, 'no_common_node', "Aucune branche commune entre vous et cette personne");
    let node: string;
    if (d.node_id) {
      if (!candidates.some(n => n.id === d.node_id)) throw new HttpError(409, 'invalid_node', "Cette branche n'est pas l'une des branches possibles pour cette visite");
      node = d.node_id;
    } else if (candidates.length === 1) node = candidates[0]!.id;
    else throw new HttpError(409, 'org_node_required', 'Plusieurs branches sont possibles : choisissez celle de la visite', { nodes: candidates });
    const id = randomUUID();
    await pool.query(
      `INSERT INTO visit(id, company_id, author_id, org_node_id, created_by, status, planned_start, location_text, objective, preparation_notes) VALUES ($1,$2,$3,$4,$5,'planned',$6,$7,$8,$9)`,
      [id, company.id, userId, node, A.id, d.planned_start ?? null, d.location_text ?? (address(company) || null), d.objective ?? null, d.preparation_notes ?? null]);
    res.status(201).json({ id });
  }));

  const patch = z.object({
    planned_start: ts.nullable().optional(), location_text: text(500), objective: text(2000), preparation_notes: text(5000),
    status: z.enum(['planned', 'organized', 'cancelled']).optional(), user_id: uuid.nullable().optional(),      // user_id : attribuer (null : retirer l'attribution)
  }).strict();

  r.patch('/prep/visits/:id', wrap(async (req, res) => {
    const b = patch.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const { user_id: newUser, ...f } = b.data; const A = req.auth!; const allowedNodes = await scopeNodes(pool, req); const scope = await scopeUsers(pool, req);
    const me = (await pool.query(`SELECT display_name FROM app_user WHERE id = $1`, [A.id])).rows[0];
    const out = await tx(pool, c => withRevocations(c, async () => {
      const v = (await c.query(`SELECT * FROM visit WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [req.params.id])).rows[0];
      // Modifiable par son auteur, par un manager/directeur ayant accès à sa branche, par un administrateur (le statut ou le rôle actuel de l'auteur n'y change rien).
      // Une visite non attribuée peut en outre être prise par une personne qui la voit (elle se l'attribue).
      const supervisor = A.role === 'manager' || A.role === 'directeur';
      const manages = !!v && (A.isAdmin || v.author_id === A.id || (supervisor && allowedNodes !== null && allowedNodes.includes(v.org_node_id)));
      const selfTake = !!v && !v.author_id && newUser === A.id && Object.keys(f).length === 0 && (await c.query(`SELECT can_read_visit($1,$2) AS ok`, [A.id, v.id])).rows[0].ok;
      if (!v || !(manages || selfTake)) throw new HttpError(404, 'not_found', 'Visite inconnue');
      if (!['planned', 'organized'].includes(v.status)) throw new HttpError(409, 'locked_status', 'Seule une visite à organiser ou organisée se modifie ici');
      const sets: string[] = []; const vals: unknown[] = [];
      for (const [k, val] of Object.entries(f)) { sets.push(`${k} = $${vals.length + 2}`); vals.push(val); }
      let oldAuthor: string | null = null; let newAuthorName: string | null = null;
      if (newUser !== undefined && newUser !== v.author_id) {
        if (newUser !== null) {
          if (!A.isAdmin && !inScope(scope, newUser)) throw new HttpError(403, 'forbidden', "Vous ne pouvez attribuer qu'à vous-même ou à votre équipe");
          const ok = (await c.query(
            `SELECT u.display_name FROM app_user u WHERE u.id = $1 AND u.status = 'active' AND u.role IN ('commercial', 'manager', 'directeur') AND can_read_company(u.id, $2) AND org_access(u.id, $3)`, [newUser, v.company_id, v.org_node_id])).rows[0];
          if (!ok) throw new HttpError(409, 'invalid_author', "Cette personne ne peut pas se voir attribuer la visite : compte inactif, client hors de son périmètre ou personne étrangère à la branche de la visite");
          newAuthorName = ok.display_name;
        } else if (!manages) throw new HttpError(403, 'forbidden', "Seuls les managers, directeurs et administrateurs retirent une attribution");
        oldAuthor = v.author_id ? (await c.query(`SELECT display_name FROM app_user WHERE id = $1`, [v.author_id])).rows[0]?.display_name ?? null : null;
        sets.push(`author_id = $${vals.length + 2}`); vals.push(newUser);
      }
      if (!sets.length) return;
      await c.query(`UPDATE visit SET ${sets.join(', ')}, version = version + 1 WHERE id = $1`, [v.id, ...vals]);
      for (const k of VISIT_HISTORY_FIELDS) {
        if (!(k in f)) continue;
        const oldV = v[k] instanceof Date ? v[k].toISOString() : v[k] ?? null; const newV = (f as any)[k] ?? null;
        if (String(oldV ?? '') === String(newV ?? '')) continue;
        await c.query(`INSERT INTO visit_history(visit_id, field, old_value, new_value, changed_by, changed_by_name) VALUES ($1,$2,$3,$4,$5,$6)`, [v.id, k, oldV, newV, A.id, me.display_name]);
      }
      if (newUser !== undefined && newUser !== v.author_id) {
        await c.query(`INSERT INTO visit_history(visit_id, field, old_value, new_value, changed_by, changed_by_name) VALUES ($1,'author',$2,$3,$4,$5)`, [v.id, oldAuthor ?? 'Non attribuée', newAuthorName ?? 'Non attribuée', A.id, me.display_name]);
      }
    }));
    res.json({ id: req.params.id, revoked: out.revoked });
  }));

  return r;
}
