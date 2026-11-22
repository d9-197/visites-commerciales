import express from 'express';
import type { Pool } from '../../db.js';
import { wrap } from '../../errors.js';
import { REPORT_LATE_DAYS } from '@visites/sync-core';
import { toCsv } from '../../csv.js';
import { scopeUsers, day, inScope } from './scope.js';
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
    const scope = await scopeUsers(pool, req);
    const userId = typeof req.query.user_id === 'string' ? req.query.user_id : undefined;
    if (userId && !inScope(scope, userId)) throw new HttpError(404, 'not_found', 'Utilisateur hors de votre périmètre');
    const ids = userId ? [userId] : scope;     // null = tout
    const P = [ids, from, addDays(to, 1), REPORT_LATE_DAYS];

    // Visites de la période : date de référence = fin du rendez-vous, sinon début, sinon date prévue.
    const VISITS = `WITH vv AS (
      SELECT v.id, v.author_id, v.company_id, v.status, v.ended_at, COALESCE(v.ended_at, v.started_at, v.planned_start) AS ref
      FROM visit v WHERE v.deleted_at IS NULL AND v.status <> 'deleted' AND ($1::uuid[] IS NULL OR v.author_id = ANY($1))
        AND COALESCE(v.ended_at, v.started_at, v.planned_start) >= $2::date AND COALESCE(v.ended_at, v.started_at, v.planned_start) < $3::date)`;

    const users = (await pool.query(
      `SELECT u.id, u.display_name, u.role FROM app_user u WHERE u.status = 'active' AND u.role = 'commercial' AND ($1::uuid[] IS NULL OR u.id = ANY($1))
         AND (NOT u.is_admin OR EXISTS (SELECT 1 FROM visit v WHERE v.author_id = u.id) OR EXISTS (SELECT 1 FROM company_assignment a WHERE a.user_id = u.id AND a.removed_at IS NULL)) ORDER BY u.display_name`, [ids])).rows;

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
       FROM action_item a WHERE ($1::uuid[] IS NULL OR a.owner_id = ANY($1)) GROUP BY a.owner_id`, [ids, from, addDays(to, 1)])).rows;

    const byUser = users.map(u => {
      const v = perUser.find(x => x.user_id === u.id) ?? {}; const a = actions.find(x => x.user_id === u.id) ?? {};
      return { user_id: u.id, name: u.display_name, planned: v.planned ?? 0, in_progress: v.in_progress ?? 0, done: v.done ?? 0, cancelled: v.cancelled ?? 0,
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
      SELECT to_char(date_trunc('week', vv.ref), 'YYYY-MM-DD') AS week, count(*)::int AS done FROM vv WHERE vv.status IN ('done','validated') GROUP BY 1 ORDER BY 1`, P.slice(0, 3))).rows;

    // Clients du périmètre (affectés à au moins un utilisateur du périmètre) : visités dans la période / sans visite depuis 90 jours.
    const clients = (await pool.query(
      `WITH cs AS (SELECT DISTINCT c.id FROM company c JOIN company_assignment a ON a.company_id = c.id AND a.removed_at IS NULL
                   WHERE c.status = 'active' AND c.deleted_at IS NULL AND ($1::uuid[] IS NULL OR a.user_id = ANY($1)))
       SELECT count(*)::int AS total,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM visit v WHERE v.company_id = cs.id AND v.deleted_at IS NULL AND v.status IN ('done','validated','in_progress')
              AND COALESCE(v.ended_at, v.started_at, v.planned_start) >= $2::date AND COALESCE(v.ended_at, v.started_at, v.planned_start) < $3::date))::int AS visited,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM visit v WHERE v.company_id = cs.id AND v.deleted_at IS NULL AND v.status IN ('done','validated','in_progress')
              AND COALESCE(v.ended_at, v.started_at, v.planned_start) >= now() - interval '90 days'))::int AS not_visited_90d
       FROM cs`, [ids, from, addDays(to, 1)])).rows[0];

    const late = (await pool.query(
      `SELECT v.id AS visit_id, c.name AS company, u.display_name AS author, v.ended_at,
              floor(extract(epoch FROM (now() - v.ended_at)) / 86400)::int AS days
       FROM visit v JOIN company c ON c.id = v.company_id JOIN app_user u ON u.id = v.author_id
       WHERE v.status = 'done' AND v.deleted_at IS NULL AND v.ended_at < now() - make_interval(days => $2::int) AND ($1::uuid[] IS NULL OR v.author_id = ANY($1))
       ORDER BY v.ended_at LIMIT 50`, [ids, REPORT_LATE_DAYS])).rows;

    return { period: { from, to }, scope: ids === null ? 'all' : 'team', totals, by_user: byUser, by_week: byWeek, clients, late_reports: late };
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
