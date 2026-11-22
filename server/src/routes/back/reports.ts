import express from 'express';
import type { Pool } from '../../db.js';
import { wrap } from '../../errors.js';
import { REPORT_LATE_DAYS } from '@visites/sync-core';
import { toCsv } from '../../csv.js';
import { scopeUsers, scopeNodes, subtree, day, authorFilter } from './scope.js';
import { HttpError } from '../../errors.js';

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

/** Reporting d'activité des visites, limité au périmètre de l'utilisateur (hiérarchie ; administrateur : tout). */
export function reportsRouter(pool: Pool) {
  const r = express.Router();

  async function activity(req: express.Request) {
    const to = day(req.query.to) ?? new Date().toISOString().slice(0, 10);
    const from = day(req.query.from) ?? addDays(to, -29);
    if (from > to) throw new HttpError(400, 'validation_failed', 'La période est inversée');
    if (Date.parse(to) - Date.parse(from) > 800 * 86400000) throw new HttpError(400, 'validation_failed', 'Période trop longue (800 jours au plus)');
    const scope = await scopeUsers(pool, req);     // utilisateurs supervisés (hiérarchie) : sert aux clients et aux comptes à lister
    const userId = typeof req.query.user_id === 'string' ? req.query.user_id : undefined;
    const ids = await authorFilter(pool, req, userId);     // auteurs des visites : tous (limités par les branches) ou un seul ; indépendant de leur statut et de leur rôle actuels
    const assignIds = userId ? [userId] : scope;     // null = tout
    // Branches : celles de l'utilisateur et leurs descendantes ; `node_id` descend dans une branche (consolidée avec ses sous-branches).
    const allowedNodes = await scopeNodes(pool, req);
    const nodeId = typeof req.query.node_id === 'string' && req.query.node_id ? req.query.node_id : undefined;
    let nodes = allowedNodes;
    if (nodeId) {
      const sub = await subtree(pool, nodeId, allowedNodes);
      if (!sub) throw new HttpError(404, 'not_found', 'Branche hors de votre périmètre');
      nodes = sub;
    }
    const viewer = nodeId ? null : req.auth!.id;     // ses propres visites comptent toujours, sauf quand on regarde une branche précise
    const P = [ids, from, addDays(to, 1), REPORT_LATE_DAYS, nodes, viewer];

    // Visites de la période : date de référence = fin du rendez-vous, sinon début, sinon date prévue.
    const VISITS = `WITH vv AS (
      SELECT v.id, v.author_id, v.company_id, v.org_node_id, v.status, v.ended_at, COALESCE(v.ended_at, v.started_at, v.planned_start) AS ref
      FROM visit v WHERE v.deleted_at IS NULL AND v.status <> 'deleted' AND ($1::uuid[] IS NULL OR v.author_id = ANY($1))
        AND ($4::int IS NOT NULL) AND ($5::uuid[] IS NULL OR v.org_node_id = ANY($5) OR v.author_id = $6::uuid)
        AND COALESCE(v.ended_at, v.started_at, v.planned_start) >= $2::date AND COALESCE(v.ended_at, v.started_at, v.planned_start) < $3::date)`;

    // Utilisateurs listés : les commerciaux actifs du périmètre, PLUS tout auteur de visite (ou responsable d'action) de la période, même désactivé ou
    // devenu manager/directeur : ses visites ne disparaissent ni des lignes ni des totaux. Complétés après les requêtes ci-dessous.
    const activeUsers = (await pool.query(
      `SELECT u.id, u.display_name, u.role, u.status FROM app_user u WHERE u.status = 'active' AND u.role = 'commercial' AND ($1::uuid[] IS NULL OR u.id = ANY($1))
         AND (NOT u.is_admin OR EXISTS (SELECT 1 FROM visit v WHERE v.author_id = u.id) OR EXISTS (SELECT 1 FROM company_assignment a WHERE a.user_id = u.id AND a.removed_at IS NULL))
         AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM user_org uo WHERE uo.user_id = u.id AND uo.node_id = ANY($2)))
       ORDER BY u.display_name`, [assignIds, nodeId ? nodes : null])).rows;

    const perUser = (await pool.query(`${VISITS}
      SELECT vv.author_id AS user_id,
        count(*) FILTER (WHERE vv.status IN ('planned','organized'))::int AS planned,
        count(*) FILTER (WHERE vv.status = 'in_progress')::int AS in_progress,
        count(*) FILTER (WHERE vv.status IN ('done','validated'))::int AS done,
        count(*) FILTER (WHERE vv.status = 'cancelled')::int AS cancelled,
        count(*) FILTER (WHERE r.status = 'validated')::int AS cr_validated,
        count(*) FILTER (WHERE vv.status = 'done')::int AS cr_pending,
        count(*) FILTER (WHERE vv.status = 'done' AND vv.ended_at < now() - make_interval(days => $4::int))::int AS cr_late,
        round(avg(extract(epoch FROM (r.validated_at - vv.ended_at)) / 86400) FILTER (WHERE r.status = 'validated' AND vv.ended_at IS NOT NULL)::numeric, 1) AS avg_cr_delay_days
      FROM vv LEFT JOIN visit_report r ON r.visit_id = vv.id GROUP BY vv.author_id`, P)).rows;

    const actions = (await pool.query(
      `SELECT a.owner_id AS user_id,
        count(*) FILTER (WHERE a.status = 'todo')::int AS todo,
        count(*) FILTER (WHERE a.status = 'todo' AND a.due_date < current_date)::int AS late,
        count(*) FILTER (WHERE a.status = 'done' AND a.completed_at >= $2::date AND a.completed_at < $3::date)::int AS done_in_period
       FROM action_item a LEFT JOIN visit v ON v.id = a.visit_id
       WHERE ($1::uuid[] IS NULL OR a.owner_id = ANY($1))
         AND (CASE WHEN v.id IS NULL THEN ($6::uuid[] IS NULL OR a.owner_id = ANY($6)) ELSE ($4::uuid[] IS NULL OR v.org_node_id = ANY($4) OR v.author_id = $5::uuid) END)
       GROUP BY a.owner_id`, [userId ? [userId] : null, from, addDays(to, 1), nodes, viewer, scope])).rows;
    const known = new Set(activeUsers.map(u => u.id as string));
    const extraIds = [...new Set([...perUser.map(x => x.user_id as string), ...actions.map(x => x.user_id as string)])].filter(id => !known.has(id));
    const extra = extraIds.length ? (await pool.query(`SELECT id, display_name, role, status FROM app_user WHERE id = ANY($1::uuid[])`, [extraIds])).rows : [];
    const users = [...activeUsers, ...extra].sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), 'fr'));

    const byUser = users.map(u => {
      const v = perUser.find(x => x.user_id === u.id) ?? {}; const a = actions.find(x => x.user_id === u.id) ?? {};
      return { user_id: u.id, name: u.display_name, role: u.role, status: u.status, planned: v.planned ?? 0, in_progress: v.in_progress ?? 0, done: v.done ?? 0, cancelled: v.cancelled ?? 0,
        cr_validated: v.cr_validated ?? 0, cr_pending: v.cr_pending ?? 0, cr_late: v.cr_late ?? 0, avg_cr_delay_days: v.avg_cr_delay_days === null || v.avg_cr_delay_days === undefined ? null : Number(v.avg_cr_delay_days),
        actions_todo: a.todo ?? 0, actions_late: a.late ?? 0, actions_done: a.done_in_period ?? 0 };
    });
    const sum = (k: keyof (typeof byUser)[number]) => byUser.reduce((n, u) => n + (Number(u[k]) || 0), 0);
    const delays = byUser.filter(u => u.avg_cr_delay_days !== null && u.cr_validated > 0);
    const totals = {
      planned: sum('planned'), in_progress: sum('in_progress'), done: sum('done'), cancelled: sum('cancelled'), cr_validated: sum('cr_validated'), cr_pending: sum('cr_pending'), cr_late: sum('cr_late'),
      actions_todo: sum('actions_todo'), actions_late: sum('actions_late'), actions_done: sum('actions_done'),
      avg_cr_delay_days: delays.length ? Math.round(delays.reduce((n, u) => n + (u.avg_cr_delay_days as number) * u.cr_validated, 0) / delays.reduce((n, u) => n + u.cr_validated, 0) * 10) / 10 : null,
    };

    const byWeek = (await pool.query(`${VISITS}
      SELECT to_char(date_trunc('week', vv.ref), 'YYYY-MM-DD') AS week, count(*)::int AS done FROM vv WHERE vv.status IN ('done','validated') GROUP BY 1 ORDER BY 1`, P)).rows;

    // Clients du périmètre (affectés à au moins un utilisateur du périmètre) : visités dans la période / sans visite depuis 90 jours.
    const clients = (await pool.query(
      `WITH cs AS (SELECT DISTINCT c.id FROM company c JOIN company_assignment a ON a.company_id = c.id AND a.removed_at IS NULL
                   WHERE c.status = 'active' AND c.deleted_at IS NULL AND ($1::uuid[] IS NULL OR a.user_id = ANY($1)))
       SELECT count(*)::int AS total,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM visit v WHERE v.company_id = cs.id AND v.deleted_at IS NULL AND v.status IN ('done','validated','in_progress')
              AND ($4::uuid[] IS NULL OR v.org_node_id = ANY($4) OR v.author_id = $5::uuid)
              AND COALESCE(v.ended_at, v.started_at, v.planned_start) >= $2::date AND COALESCE(v.ended_at, v.started_at, v.planned_start) < $3::date))::int AS visited,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM visit v WHERE v.company_id = cs.id AND v.deleted_at IS NULL AND v.status IN ('done','validated','in_progress')
              AND ($4::uuid[] IS NULL OR v.org_node_id = ANY($4) OR v.author_id = $5::uuid)
              AND COALESCE(v.ended_at, v.started_at, v.planned_start) >= now() - interval '90 days'))::int AS not_visited_90d
       FROM cs`, [assignIds, from, addDays(to, 1), nodes, viewer])).rows[0];

    const late = (await pool.query(
      `SELECT v.id AS visit_id, c.name AS company, u.display_name AS author, v.ended_at,
              floor(extract(epoch FROM (now() - v.ended_at)) / 86400)::int AS days
       FROM visit v JOIN company c ON c.id = v.company_id JOIN app_user u ON u.id = v.author_id
       WHERE v.status = 'done' AND v.deleted_at IS NULL AND v.ended_at < now() - make_interval(days => $2::int) AND ($1::uuid[] IS NULL OR v.author_id = ANY($1))
         AND ($3::uuid[] IS NULL OR v.org_node_id = ANY($3) OR v.author_id = $4::uuid)
       ORDER BY v.ended_at LIMIT 50`, [ids, REPORT_LATE_DAYS, nodes, viewer])).rows;

    // Consolidation par branche : chaque nœud cumule ses visites et celles de ses sous-branches (celles que l'utilisateur peut voir).
    const byNode = (await pool.query(`${VISITS}
      SELECT n.id AS node_id, n.parent_id, n.name, org_path(n.id) AS path,
        (SELECT max(c2.depth) FROM org_closure c2 WHERE c2.descendant_id = n.id)::int AS depth,
        (SELECT count(*)::int FROM user_org uo WHERE uo.node_id = n.id) AS members,
        count(vv.id) FILTER (WHERE vv.status IN ('planned','organized'))::int AS planned,
        count(vv.id) FILTER (WHERE vv.status = 'in_progress')::int AS in_progress,
        count(vv.id) FILTER (WHERE vv.status IN ('done','validated'))::int AS done,
        count(vv.id) FILTER (WHERE vv.status = 'cancelled')::int AS cancelled,
        count(vv.id) FILTER (WHERE r.status = 'validated')::int AS cr_validated,
        count(vv.id) FILTER (WHERE vv.status = 'done')::int AS cr_pending,
        count(vv.id) FILTER (WHERE vv.status = 'done' AND vv.ended_at < now() - make_interval(days => $4::int))::int AS cr_late
      FROM org_node n
      LEFT JOIN org_closure c ON c.ancestor_id = n.id
      LEFT JOIN vv ON vv.org_node_id = c.descendant_id
      LEFT JOIN visit_report r ON r.visit_id = vv.id
      WHERE ($5::uuid[] IS NULL OR n.id = ANY($5))
      GROUP BY n.id ORDER BY org_path(n.id)`, P)).rows;

    return { period: { from, to }, scope: ids === null ? 'all' : 'team', node_id: nodeId ?? null, totals, by_user: byUser, by_node: byNode, by_week: byWeek, clients, late_reports: late };
  }

  r.get('/reports/activity', wrap(async (req, res) => { res.json(await activity(req)); }));

  r.get('/reports/activity.csv', wrap(async (req, res) => {
    const a = await activity(req);
    const head = ['Commercial', 'Visites prévues', 'En cours', 'Effectuées', 'Annulées', 'CR validés', 'CR à valider', 'CR en retard', 'Délai moyen de validation du CR (jours)', 'Actions à faire', 'Actions en retard', 'Actions terminées (période)'];
    const rows = a.by_user.map(u => [u.name, u.planned, u.in_progress, u.done, u.cancelled, u.cr_validated, u.cr_pending, u.cr_late, u.avg_cr_delay_days ?? '', u.actions_todo, u.actions_late, u.actions_done]);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="activite-${a.period.from}-${a.period.to}.csv"` }).send(toCsv(head, rows));
  }));

  return r;
}
