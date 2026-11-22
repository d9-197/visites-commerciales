import type { Pool } from '../db.js';
import type { Config } from '../config.js';
import { HttpError } from '../errors.js';
import type { PullResponse, ChangeKey } from '@visites/sync-core';

interface Spec { key: ChangeKey | 'revocations'; sql: string }

// Une requête par type de donnée : numéro de changement > curseur, filtrée par la règle de visibilité de l'utilisateur ($1).
const SPECS: Spec[] = [
  { key: 'companies', sql: `SELECT id,name,address_line,postal_code,city,country,sector,status,updated_at,deleted_at,seq FROM company t WHERE t.seq > $2 AND can_read_company($1, t.id)` },
  { key: 'contacts', sql: `SELECT id,company_id,full_name,job_title,phone,email,active,updated_at,deleted_at,seq FROM contact t WHERE t.seq > $2 AND can_read_company($1, t.company_id)` },
  { key: 'assignments', sql: `SELECT company_id,user_id,removed_at,seq FROM company_assignment t WHERE t.seq > $2 AND can_read_company($1, t.company_id)` },
  { key: 'colleagues', sql: `SELECT id,display_name,seq FROM app_user t WHERE t.seq > $2 AND (t.id = $1
      OR EXISTS (SELECT 1 FROM user_hierarchy h WHERE h.ancestor_id = $1 AND h.descendant_id = t.id)
      OR EXISTS (SELECT 1 FROM visit v WHERE v.author_id = t.id AND can_read_visit($1, v.id)))` },
  { key: 'visits', sql: `SELECT id,company_id,author_id,created_by,(SELECT u.display_name FROM app_user u WHERE u.id = t.created_by) AS created_by_name,visit_type,objective,preparation_notes,planned_start,planned_end,started_at,ended_at,location_text,status,version,updated_at,deleted_at,seq FROM visit t WHERE t.seq > $2 AND can_read_visit($1, t.id)` },
  { key: 'visit_history', sql: `SELECT id,visit_id,field,old_value,new_value,changed_by_name,changed_at,seq FROM visit_history t WHERE t.seq > $2 AND can_read_visit($1, t.visit_id)` },
  { key: 'visit_contacts', sql: `SELECT visit_id,contact_id,removed_at,seq FROM visit_contact t WHERE t.seq > $2 AND can_read_visit($1, t.visit_id)` },
  { key: 'reports', sql: `SELECT id,visit_id,language,summary,needs,objections,competitors,decisions,next_step,opportunity_temperature,draft_actions,no_action,sent_to_client_at,status,validated_at,version,updated_at,seq FROM visit_report t WHERE t.seq > $2 AND can_read_visit($1, t.visit_id)` },
  { key: 'notes', sql: `SELECT id,visit_id,author_id,kind,body,recording_id,attachment_id,noted_at,updated_at,deleted_at,seq FROM visit_note t WHERE t.seq > $2 AND can_read_visit($1, t.visit_id)` },
  { key: 'internal_notes', sql: `SELECT id,visit_id,author_id,author_name,body,updated_at,deleted_at,seq FROM internal_note t WHERE t.seq > $2 AND can_read_internal_note($1, t.id)` },
  { key: 'private_notes', sql: `SELECT id,visit_id,body,version,updated_at,deleted_at,seq FROM private_note t WHERE t.seq > $2 AND t.author_id = $1` },
  { key: 'actions', sql: `SELECT id,company_id,visit_id,author_id,owner_id,title,due_date,reminder,status,origin,version,updated_at,seq FROM action_item t WHERE t.seq > $2 AND can_read_action($1, t.id)` },
  { key: 'revocations', sql: `SELECT entity,entity_id,seq FROM access_revocation t WHERE t.user_id = $1 AND t.seq > $2` },
];

export const encodeCursor = (seq: number) => Buffer.from(JSON.stringify({ s: seq })).toString('base64url');
export function decodeCursor(c: string | undefined): number {
  if (!c) return 0;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString());
    if (typeof v.s === 'number' && v.s >= 0) return v.s;
  } catch { /* tombe sur l'erreur ci-dessous */ }
  throw new HttpError(410, 'cursor_expired', 'Curseur invalide : refaire une synchronisation initiale');
}

/**
 * Lecture incrémentale.
 *  - Pagination : tant que has_more, le curseur est strict (le dernier numéro renvoyé).
 *  - Fin de lecture : le curseur recule de `syncOverlap` numéros. Une transaction qui valide en retard (numéro plus petit que
 *    ceux déjà vus) est ainsi relue à la synchro suivante. L'application remplace chaque ligne par son identifiant :
 *    relire une ligne est sans effet.
 */
export async function pull(pool: Pool, cfg: Config, userId: string, cursor: string | undefined, limitIn?: number): Promise<PullResponse> {
  const from = decodeCursor(cursor);
  const limit = Math.min(Math.max(limitIn ?? cfg.pullDefaultLimit, 1), 500);
  const results = await Promise.all(SPECS.map(async s => {
    const { rows } = await pool.query(`${s.sql} ORDER BY t.seq LIMIT $3`, [userId, from, limit + 1]);
    return rows.map(r => ({ key: s.key, row: r }));
  }));
  const merged = results.flat().sort((a, b) => a.row.seq - b.row.seq);
  const hasMore = merged.length > limit;
  const page = hasMore ? merged.slice(0, limit) : merged;

  const changes: PullResponse['changes'] = {};
  const revocations: PullResponse['revocations'] = [];
  for (const { key, row } of page) {
    const { seq: _seq, ...data } = row;
    if (key === 'revocations') revocations.push(data as { entity: string; entity_id: string });
    else (changes[key] ??= []).push(data);
  }
  const maxSeq = page.length ? page[page.length - 1]!.row.seq : from;
  const next = hasMore ? maxSeq : (page.length ? Math.max(from, maxSeq - cfg.syncOverlap) : from);
  return { next_cursor: encodeCursor(next), has_more: hasMore, server_time: new Date().toISOString(), changes, revocations };
}
