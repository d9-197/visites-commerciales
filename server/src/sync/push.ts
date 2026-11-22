import { z } from 'zod';
import type { Pool, Client } from '../db.js';
import { tx } from '../db.js';
import { HttpError } from '../errors.js';
import { LONG_TEXT_FIELDS, VERSIONED, VISIT_HISTORY_FIELDS, canEditVisitAddress, canEditVisitDate, canDeleteVisit, canEditInternalNote, canEditVisitNotes, isDueBeforeVisit, needsNoActionAck, canTransition, canValidateReport } from '@visites/sync-core';
import type { UserRole, VisitStatus } from '@visites/sync-core';
import type { Operation, OperationResult, ConflictField, EntityName } from '@visites/sync-core';

/** Refus d'une opération : n'arrête pas les suivantes (sauf celles qui en dépendent). */
class Reject extends Error { constructor(public code: string, message: string) { super(message); } }

const uuid = z.string().uuid();
const ts = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nstr = z.string().nullable();

const VISIT_FIELDS = {
  visit_type: nstr, objective: nstr, preparation_notes: nstr, planned_start: ts.nullable(), planned_end: ts.nullable(),
  started_at: ts.nullable(), ended_at: ts.nullable(), location_text: z.string().max(500).nullable(),
  status: z.enum(['planned', 'organized', 'in_progress', 'done', 'validated', 'cancelled', 'deleted']),
};
const DRAFT_ACTION = z.object({ id: uuid, title: z.string().trim().min(1).max(200), due_date: date.nullable(), origin: z.enum(['ai', 'manual']) });
const REPORT_FIELDS = {
  draft_actions: z.array(DRAFT_ACTION).max(30),
  no_action: z.boolean(),
  summary: nstr, needs: nstr, objections: nstr, competitors: nstr, decisions: nstr, next_step: nstr,
  opportunity_temperature: z.enum(['cold', 'warm', 'hot']).nullable(), status: z.enum(['draft', 'validated']),
};
const ACTION_FIELDS = {
  title: z.string().trim().min(1), due_date: date.nullable(), reminder: z.enum(['none', 'same_day_9h', 'eve_17h']),
  status: z.enum(['todo', 'done', 'cancelled']),
};

function optional<T extends Record<string, z.ZodTypeAny>>(o: T): { [K in keyof T]: z.ZodOptional<T[K]> } {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.optional()])) as any;
}

const S = {
  visitCreate: z.object({ company_id: uuid, ...optional(VISIT_FIELDS) }).strict(),
  visitUpdate: z.object(optional(VISIT_FIELDS)).strict(),
  reportCreate: z.object({ visit_id: uuid, language: z.enum(['fr', 'en', 'es', 'it', 'de', 'nl']), ...optional(REPORT_FIELDS) }).strict(),
  reportUpdate: z.object(optional(REPORT_FIELDS)).strict(),
  noteCreate: z.object({ visit_id: uuid, kind: z.enum(['text', 'voice', 'photo']), body: nstr.optional(), noted_at: ts.optional() }).strict(),
  noteUpdate: z.object({ body: nstr }).strict(),
  internalCreate: z.object({ visit_id: uuid, body: z.string().trim().min(1).max(10000) }).strict(),
  internalUpdate: z.object({ body: z.string().trim().min(1).max(10000) }).strict(),
  privateCreate: z.object({ visit_id: uuid, body: z.string().min(1) }).strict(),
  privateUpdate: z.object({ body: z.string().min(1) }).strict(),
  actionCreate: z.object({
    company_id: uuid, visit_id: uuid.optional(), origin: z.enum(['manual', 'dictated', 'ai']).optional(), title: ACTION_FIELDS.title,
    due_date: ACTION_FIELDS.due_date.optional(), reminder: ACTION_FIELDS.reminder.optional(), status: z.literal('todo').optional(),
  }).strict(),
  actionUpdate: z.object(optional(ACTION_FIELDS)).strict(),
  visitContact: z.object({ visit_id: uuid, contact_id: uuid }).strict(),
};

interface Applied { version?: number; fields: string[]; conflicts?: ConflictField[]; serverVersion?: number }
interface Ctx { c: Client; userId: string; op: Operation }

const normalize = (v: unknown): unknown => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toISOString();
  return v ?? null;
};

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new Reject('validation_failed', r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

async function changedFieldsSince(c: Client, entity: string, id: string, baseVersion: number): Promise<Set<string>> {
  const { rows } = await c.query(
    `SELECT detail->'applied_fields' AS f FROM client_operation
     WHERE entity = $1 AND entity_id = $2 AND result IN ('applied','conflict') AND (detail->>'version_after')::int > $3`,
    [entity, id, baseVersion]);
  return new Set(rows.flatMap(r => (r.f as string[] | null) ?? []));
}

/** Modification d'une entité versionnée avec détection de conflit par champ. */
async function updateVersioned(
  { c, userId, op }: Ctx, table: string, row: Record<string, any>, fields: Record<string, unknown>,
  derive?: (merged: Record<string, any>, toApply: Record<string, unknown>) => void,
  after?: (applied: Record<string, unknown>) => Promise<void>,
): Promise<Applied> {
  if (typeof op.base_version !== 'number') throw new Reject('validation_failed', 'base_version requis');
  if (op.base_version > row.version) throw new Reject('validation_failed', 'base_version supérieure à la version du serveur');
  const serverChanged = op.base_version < row.version
    ? await changedFieldsSince(c, op.entity, op.entity_id, op.base_version) : new Set<string>();
  const longs = new Set(LONG_TEXT_FIELDS[op.entity] ?? []);
  const toApply: Record<string, unknown> = {};
  const conflicts: ConflictField[] = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val === undefined) continue;
    if (serverChanged.has(col) && JSON.stringify(normalize(val)) !== JSON.stringify(normalize(row[col]))) {
      if (longs.has(col)) {
        await c.query(
          `INSERT INTO text_conflict(entity, entity_id, field, user_id, device_value, server_value) VALUES ($1,$2,$3,$4,$5,$6)`,
          [op.entity, op.entity_id, col, userId, val as string, row[col] as string]);
        conflicts.push({ field: col, server_value: row[col], resolution: 'both_kept' });
      } else conflicts.push({ field: col, server_value: normalize(row[col]), resolution: 'server_wins' });
    } else toApply[col] = val;
  }
  if (derive) derive({ ...row, ...toApply }, toApply);
  const cols = Object.keys(toApply);
  let version = row.version as number;
  if (cols.length) {
    const sets = cols.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const r = await c.query(`UPDATE ${table} SET ${sets}, version = version + 1 WHERE id = $1 RETURNING version`, [op.entity_id, ...cols.map(k => jsonParam(toApply[k]))]);
    version = r.rows[0].version;
    if (after) await after(toApply);
  }
  return { version, fields: cols, conflicts, serverVersion: row.version };
}

async function visitRow(c: Client, userId: string, id: string, authorOnly: boolean) {
  const { rows } = await c.query(`SELECT * FROM visit WHERE id = $1 FOR UPDATE`, [id]);
  const v = rows[0];
  const readable = v && (await c.query(`SELECT can_read_visit($1,$2) AS ok`, [userId, id])).rows[0].ok;
  if (!v || !readable) throw new Reject('not_found', 'Visite inconnue');
  if (authorOnly && v.author_id !== userId) throw new Reject('forbidden', "Réservé à l'auteur de la visite");
  return v;
}

/** Une visite terminée dont le compte rendu est validé devient « validée » (dans la même transaction). */
async function autoValidate(c: Client, visitId: string) {
  await c.query(
    `UPDATE visit v SET status = 'validated', version = version + 1
     WHERE v.id = $1 AND v.status = 'done' AND EXISTS (SELECT 1 FROM visit_report r WHERE r.visit_id = v.id AND r.status = 'validated')`, [visitId]);
}

/** Événement ajouté à l'historique de la visite (compte rendu validé, remis en brouillon, visite supprimée). */
async function logEvent(c: Client, visitId: string, field: string, userId: string) {
  const name = (await c.query(`SELECT display_name FROM app_user WHERE id = $1`, [userId])).rows[0].display_name;
  await c.query(`INSERT INTO visit_history(visit_id, field, changed_by, changed_by_name) VALUES ($1,$2,$3,$4)`, [visitId, field, userId, name]);
}

/** Validation d'un compte rendu : « aucune action à prévoir » obligatoire s'il n'y a aucune action ; échéances cohérentes avec la visite. */
async function checkValidation(c: Client, visit: Record<string, any>, drafts: any[], noAction: boolean) {
  const existing = (await c.query(`SELECT count(*)::int AS n FROM action_item WHERE visit_id = $1`, [visit.id])).rows[0].n;
  if (needsNoActionAck(drafts.length, existing, noAction)) throw new Reject('validation_failed', 'Ajoutez une action ou cochez « aucune action à prévoir » avant de valider');
  checkDueDates(visit, drafts);
}
function checkDueDates(visit: Record<string, any>, drafts: { due_date?: string | null }[]) {
  if (drafts.some(a => isDueBeforeVisit(a.due_date, visit))) throw new Reject('validation_failed', "L'échéance d'une action est antérieure à la date de la visite");
}

async function companyReadable(c: Client, userId: string, id: string) {
  const ok = (await c.query(`SELECT can_read_company($1,$2) AS ok`, [userId, id])).rows[0].ok;
  if (!ok) throw new Reject('forbidden', 'Client non accessible');
}

/** Les objets et tableaux sont envoyés en JSON (colonnes jsonb) ; pg les prendrait sinon pour des tableaux SQL. */
const jsonParam = (x: unknown) => (x !== null && typeof x === 'object' && !(x instanceof Date) ? JSON.stringify(x) : x);

/** Actions prévues dans le compte rendu : créées à la validation, par le serveur, dans la même transaction. */
async function createActionsFromDraft(c: Client, row: { visit_id: string; company_id: string; author_id: string }, drafts: any[]) {
  for (const a of drafts) {
    await c.query(
      `INSERT INTO action_item(id, company_id, visit_id, author_id, owner_id, title, due_date, origin) VALUES ($1,$2,$3,$4,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [a.id, row.company_id, row.visit_id, row.author_id, a.title, a.due_date ?? null, a.origin === 'ai' ? 'ai' : 'manual']);
  }
}

async function insert(c: Client, table: string, data: Record<string, unknown>) {
  const cols = Object.keys(data);
  try {
    await c.query(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map(k => jsonParam(data[k])));
  } catch (e: any) {
    if (e.code === '23505') throw new Reject('already_exists', 'Existe déjà');
    if (e.code === '23503') throw new Reject('not_found', 'Référence inconnue');
    if (e.code === '23514') throw new Reject('validation_failed', 'Contrainte non respectée');
    throw e;
  }
}

async function handle(ctx: Ctx): Promise<Applied> {
  const { c, userId, op } = ctx;
  const id = op.entity_id;
  switch (op.entity) {
    case 'visit': {
      if (op.op === 'create') {
        const p = parse(S.visitCreate, op.payload);
        if (p.status === 'validated') throw new Reject('validation_failed', 'Le statut « validée » est attribué automatiquement');
        await companyReadable(c, userId, p.company_id);
        await insert(c, 'visit', { id, author_id: userId, ...p });
        return { version: 1, fields: Object.keys(p) };
      }
      if (op.op === 'update') {
        const row = await visitRow(c, userId, id, false);             // lisible par l'appelant, sinon « inconnue »
        if (row.deleted_at) throw new Reject('locked_status', 'Visite supprimée');
        const fields = parse(S.visitUpdate, op.payload);
        const keys = Object.keys(fields);
        const isAuthor = row.author_id === userId;
        const me = (await c.query(`SELECT role, display_name FROM app_user WHERE id = $1`, [userId])).rows[0];
        // L'adresse peut être modifiée par d'autres que l'auteur, selon le statut et le rôle ; tout le reste : l'auteur seul.
        const onlyDelete = keys.length === 1 && fields.status === 'deleted';
        if (!isAuthor && !(keys.length > 0 && keys.every(k => k === 'location_text')) && !(onlyDelete && me.role === 'directeur')) throw new Reject('forbidden', "Réservé à l'auteur de la visite");
        if (fields.status === 'cancelled' && row.status !== 'cancelled') {
          const open = (await c.query(`SELECT count(*)::int AS n FROM action_item WHERE visit_id = $1 AND status = 'todo'`, [id])).rows[0].n;
          if (open > 0) throw new Reject('locked_status', 'Des actions restent à faire : terminez-les ou annulez-les avant d\'annuler la visite');
        }
        if (fields.status === 'deleted' && row.status !== 'deleted') {
          if (!canDeleteVisit(me.role as UserRole, isAuthor)) throw new Reject('forbidden', 'Seul le commercial auteur de la visite ou un directeur peut la supprimer');
          const open = (await c.query(`SELECT count(*)::int AS n FROM action_item WHERE visit_id = $1 AND status = 'todo'`, [id])).rows[0].n;
          if (open > 0) throw new Reject('locked_status', 'Des actions restent à faire : terminez-les ou annulez-les avant de supprimer la visite');
        }
        if ('location_text' in fields && !canEditVisitAddress(row.status as VisitStatus, me.role as UserRole)) {
          throw new Reject('locked_status', row.status === 'organized' ? "Une fois la visite organisée, l'adresse n'est modifiable que par un commercial" : "L'adresse n'est plus modifiable une fois la visite commencée");
        }
        if (('planned_start' in fields || 'planned_end' in fields) && !canEditVisitDate(row.status as VisitStatus, isAuthor)) {
          throw new Reject('locked_status', 'La date prévue n\'est plus modifiable une fois la visite commencée');
        }
        if (('objective' in fields || 'preparation_notes' in fields) && !canEditVisitNotes(row.status as VisitStatus)) throw new Reject('locked_status', "L'objectif et les points à aborder ne sont plus modifiables une fois la visite terminée");
        if (fields.status === 'validated') throw new Reject('locked_status', 'Le statut « validée » est attribué automatiquement quand le compte rendu est validé');
        if (fields.status && !canTransition(row.status as VisitStatus, fields.status as VisitStatus)) {
          throw new Reject('locked_status', `Passage impossible de « ${row.status} » à « ${fields.status} »`);
        }
        return updateVersioned(ctx, 'visit', row, fields, undefined, async applied => {
          if (applied.status === 'deleted') await logEvent(c, id, 'visit_deleted', userId);
          if (applied.status === 'done') await autoValidate(c, id);   // compte rendu déjà validé : la visite est validée aussitôt
          for (const f of VISIT_HISTORY_FIELDS) {
            if (!(f in applied)) continue;
            const oldV = row[f] instanceof Date ? row[f].toISOString() : row[f] ?? null;
            const newV = applied[f] ?? null;
            if (String(oldV ?? '') === String(newV ?? '')) continue;
            await c.query(`INSERT INTO visit_history(visit_id, field, old_value, new_value, changed_by, changed_by_name) VALUES ($1,$2,$3,$4,$5,$6)`,
              [id, f, oldV, newV, userId, me.display_name]);
          }
        });
      }
      throw new Reject('validation_failed', 'Une visite ne se supprime pas : passer son statut à cancelled');
    }
    case 'visit_contact': {
      const p = parse(S.visitContact, op.payload);
      const v = await visitRow(c, userId, p.visit_id, true);
      if (op.op === 'create') {
        const ct = (await c.query(`SELECT company_id FROM contact WHERE id = $1`, [p.contact_id])).rows[0];
        if (!ct || ct.company_id !== v.company_id) throw new Reject('validation_failed', 'Contact absent du client de la visite');
        await c.query(`INSERT INTO visit_contact(visit_id, contact_id) VALUES ($1,$2) ON CONFLICT (visit_id, contact_id) DO UPDATE SET removed_at = NULL`, [p.visit_id, p.contact_id]);
      } else if (op.op === 'delete') {
        await c.query(`UPDATE visit_contact SET removed_at = now() WHERE visit_id = $1 AND contact_id = $2`, [p.visit_id, p.contact_id]);
      } else throw new Reject('validation_failed', 'Opération non prévue');
      return { fields: ['removed_at'] };
    }
    case 'report': {
      if (op.op === 'create') {
        const p = parse(S.reportCreate, op.payload);
        const vr = await visitRow(c, userId, p.visit_id, true);
        if (vr.status === 'deleted') throw new Reject('locked_status', 'Visite supprimée');
        if (p.status === 'validated' && !canValidateReport(vr.status)) throw new Reject('locked_status', 'La visite doit être terminée pour valider le compte rendu');
        if (p.status === 'validated' && !(p.summary ?? '').trim()) throw new Reject('validation_failed', 'summary requis pour valider');
        if (p.status === 'validated') await checkValidation(c, vr, p.draft_actions ?? [], p.no_action ?? false);
        else checkDueDates(vr, p.draft_actions ?? []);
        const extra = p.status === 'validated' ? { validated_at: new Date().toISOString(), validated_by: userId } : {};
        await insert(c, 'visit_report', { id, ...p, ...extra });
        if (p.status === 'validated') { await createActionsFromDraft(c, { visit_id: p.visit_id, company_id: vr.company_id, author_id: userId }, p.draft_actions ?? []); await c.query(`UPDATE visit_report SET draft_actions = '[]' WHERE id = $1`, [id]); await autoValidate(c, p.visit_id); await logEvent(c, p.visit_id, 'report_validated', userId); }
        return { version: 1, fields: Object.keys(p) };
      }
      if (op.op === 'update') {
        const { rows } = await c.query(`SELECT r.*, v.author_id, v.status AS visit_status, v.company_id, v.started_at, v.planned_start FROM visit_report r JOIN visit v ON v.id = r.visit_id WHERE r.id = $1 FOR UPDATE OF r`, [id]);
        const row = rows[0];
        if (!row || !(await c.query(`SELECT can_read_visit($1,$2) AS ok`, [userId, row.visit_id])).rows[0].ok) throw new Reject('not_found', 'Compte rendu inconnu');
        if (row.author_id !== userId) throw new Reject('forbidden', "Réservé à l'auteur");
        if (row.visit_status === 'deleted') throw new Reject('locked_status', 'Visite supprimée');
        const fields = parse(S.reportUpdate, op.payload);
        const keys = Object.keys(fields);
        // Un compte rendu validé n'est plus modifiable ; seule sa remise en brouillon est possible.
        if (row.status === 'validated' && !(keys.length === 1 && fields.status === 'draft')) {
          throw new Reject('locked_status', 'Compte rendu validé : remettez-le en brouillon pour le modifier');
        }
        let pending: any[] = [];
        if (row.status === 'validated' && row.sent_to_client_at) throw new Reject('locked_status', 'Compte rendu transmis au client : il ne peut plus être remis en brouillon');
        if (fields.draft_actions) checkDueDates({ started_at: row.started_at, planned_start: row.planned_start }, fields.draft_actions);
        const existingActions = row.status !== 'validated' && fields.status === 'validated' ? (await c.query(`SELECT count(*)::int AS n FROM action_item WHERE visit_id = $1`, [row.visit_id])).rows[0].n : 0;
        return updateVersioned(ctx, 'visit_report', row, fields, (merged, toApply) => {
          if (row.status === 'validated' && merged.status === 'draft') { toApply.validated_at = null; toApply.validated_by = null; return; }
          if (row.status !== 'validated' && merged.status === 'validated') {
            if (!canValidateReport(row.visit_status)) throw new Reject('locked_status', 'La visite doit être terminée pour valider le compte rendu');
            if (!String(merged.summary ?? '').trim()) throw new Reject('validation_failed', 'summary requis pour valider');
            const nDrafts = Array.isArray(merged.draft_actions) ? merged.draft_actions.length : 0;
            if (needsNoActionAck(nDrafts, existingActions, !!merged.no_action)) throw new Reject('validation_failed', 'Ajoutez une action ou cochez « aucune action à prévoir » avant de valider');
            toApply.validated_at = new Date().toISOString(); toApply.validated_by = userId;
            pending = Array.isArray(merged.draft_actions) ? merged.draft_actions : [];
            toApply.draft_actions = [];                      // les actions prévues deviennent de vraies actions (ci-dessous)
          }
        }, async applied => {
          if (applied.status === 'validated') { await createActionsFromDraft(c, row, pending); await autoValidate(c, row.visit_id); await logEvent(c, row.visit_id, 'report_validated', userId); }
          if (applied.status === 'draft' && row.status === 'validated') {   // remise en brouillon : la visite redevient « terminée »
            await c.query(`UPDATE visit SET status = 'done', version = version + 1 WHERE id = $1 AND status = 'validated'`, [row.visit_id]);
            await logEvent(c, row.visit_id, 'report_reopened', userId);
          }
        });
      }
      throw new Reject('validation_failed', 'Un compte rendu ne se supprime pas');
    }
    case 'note': {
      if (op.op === 'create') {
        const p = parse(S.noteCreate, op.payload);
        const vn = await visitRow(c, userId, p.visit_id, true);
        if (!canEditVisitNotes(vn.status)) throw new Reject('locked_status', 'La visite est terminée : les notes ne sont plus modifiables');
        await insert(c, 'visit_note', { id, author_id: userId, ...p });
        return { fields: Object.keys(p) };
      }
      const { rows } = await c.query(`SELECT n.*, v.status AS visit_status FROM visit_note n JOIN visit v ON v.id = n.visit_id WHERE n.id = $1 FOR UPDATE OF n`, [id]);
      const n = rows[0];
      if (!n) throw new Reject('not_found', 'Note inconnue');
      if (n.author_id !== userId) throw new Reject('forbidden', "Réservé à l'auteur");
      if (!canEditVisitNotes(n.visit_status)) throw new Reject('locked_status', 'La visite est terminée : les notes ne sont plus modifiables');
      if (op.op === 'update') {
        const p = parse(S.noteUpdate, op.payload);
        await c.query(`UPDATE visit_note SET body = $2 WHERE id = $1`, [id, p.body]);
        return { fields: ['body'] };
      }
      await c.query(`UPDATE visit_note SET deleted_at = now() WHERE id = $1`, [id]);
      return { fields: ['deleted_at'] };
    }
    case 'internal_note': {
      // Écriture : les commerciaux qui voient la visite. Lecture : l'auteur et sa hiérarchie (lecture seule pour elle).
      if (op.op === 'create') {
        const p = parse(S.internalCreate, op.payload);
        const me = (await c.query(`SELECT role, display_name FROM app_user WHERE id = $1`, [userId])).rows[0];
        const vi = await visitRow(c, userId, p.visit_id, false);
        if (vi.status === 'deleted') throw new Reject('locked_status', 'Visite supprimée');
        if (me.role !== 'commercial') throw new Reject('forbidden', 'Les notes internes sont écrites par les commerciaux');
        await insert(c, 'internal_note', { id, author_id: userId, author_name: me.display_name, ...p });
        return { fields: Object.keys(p) };
      }
      const n = (await c.query(`SELECT * FROM internal_note WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!n || !(await c.query(`SELECT can_read_internal_note($1,$2) AS ok`, [userId, id])).rows[0].ok) throw new Reject('not_found', 'Note interne inconnue');
      if (n.author_id !== userId) throw new Reject('forbidden', "Réservé à l'auteur de la note");
      const vs = (await c.query(`SELECT status FROM visit WHERE id = $1`, [n.visit_id])).rows[0].status;
      if (!canEditInternalNote(vs)) throw new Reject('locked_status', 'Compte rendu validé : les notes internes existantes ne se modifient plus (vous pouvez en ajouter)');
      if (op.op === 'update') { const p = parse(S.internalUpdate, op.payload); await c.query(`UPDATE internal_note SET body = $2 WHERE id = $1`, [id, p.body]); return { fields: ['body'] }; }
      await c.query(`UPDATE internal_note SET deleted_at = now() WHERE id = $1`, [id]);
      return { fields: ['deleted_at'] };
    }
    case 'private_note': {
      if (op.op === 'create') {
        const p = parse(S.privateCreate, op.payload);
        await visitRow(c, userId, p.visit_id, false);
        await insert(c, 'private_note', { id, author_id: userId, ...p });
        return { version: 1, fields: Object.keys(p) };
      }
      const { rows } = await c.query(`SELECT * FROM private_note WHERE id = $1 AND author_id = $2 FOR UPDATE`, [id, userId]);
      const n = rows[0];
      if (!n) throw new Reject('not_found', 'Note privée inconnue');   // une note d'un autre auteur est « inconnue », jamais « interdite »
      if (op.op === 'update') return updateVersioned(ctx, 'private_note', n, parse(S.privateUpdate, op.payload));
      await c.query(`UPDATE private_note SET deleted_at = now() WHERE id = $1`, [id]);
      return { fields: ['deleted_at'] };
    }
    case 'action': {
      if (op.op === 'create') {
        // Les actions naissent d'une visite : jamais seules, et seulement une fois le compte rendu validé (création automatique à la validation,
        // ou ajout manuel ensuite). Avant, elles ne sont que des « actions prévues » dans le brouillon du compte rendu.
        const p = parse(S.actionCreate, op.payload);
        if (!p.visit_id) throw new Reject('validation_failed', 'Une action est créée depuis une visite (visit_id requis)');
        const va = await visitRow(c, userId, p.visit_id, true);
        if (va.status === 'deleted') throw new Reject('locked_status', 'Visite supprimée');
        if (isDueBeforeVisit(p.due_date, va)) throw new Reject('validation_failed', "L'échéance est antérieure à la date de la visite");
        if (va.company_id !== p.company_id) throw new Reject('validation_failed', 'Le client ne correspond pas à la visite');
        const validated = (await c.query(`SELECT 1 FROM visit_report WHERE visit_id = $1 AND status = 'validated'`, [p.visit_id])).rows[0];
        if (!validated) throw new Reject('locked_status', 'Les actions ne sont créées qu\'une fois le compte rendu validé');
        await insert(c, 'action_item', { id, author_id: userId, owner_id: userId, ...p });
        return { version: 1, fields: Object.keys(p) };
      }
      if (op.op === 'update') {
        const row = (await c.query(`SELECT * FROM action_item WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!row || !(await c.query(`SELECT can_read_action($1,$2) AS ok`, [userId, id])).rows[0].ok) throw new Reject('not_found', 'Action inconnue');
        if (row.owner_id !== userId) throw new Reject('forbidden', 'Réservé au responsable');
        const upd = parse(S.actionUpdate, op.payload);
        if (upd.due_date && row.visit_id) {
          const av = (await c.query(`SELECT started_at, planned_start FROM visit WHERE id = $1`, [row.visit_id])).rows[0];
          if (av && isDueBeforeVisit(upd.due_date, av)) throw new Reject('validation_failed', "L'échéance est antérieure à la date de la visite");
        }
        return updateVersioned(ctx, 'action_item', row, upd, (merged, toApply) => {
          if (merged.status !== row.status) toApply.completed_at = merged.status === 'done' ? new Date().toISOString() : null;
        });
      }
      throw new Reject('validation_failed', 'Une action ne se supprime pas : passer son statut à cancelled');
    }
    default:
      throw new Reject('not_implemented', `Entité non prise en charge par ce prototype : ${op.entity}`);
  }
}

const opSchema = z.object({
  id: uuid, entity: z.string(), entity_id: uuid, op: z.enum(['create', 'update', 'delete']),
  base_version: z.number().int().optional(), payload: z.record(z.unknown()),
});
export const pushSchema = z.object({ device_id: uuid.optional(), operations: z.array(z.unknown()).min(1).max(200) });

export async function push(pool: Pool, userId: string, deviceId: string | null, rawOps: unknown[]): Promise<OperationResult[]> {
  const failed = new Set<string>();   // entités dont la création a échoué : les opérations qui en dépendent sont refusées
  const out: OperationResult[] = [];
  for (const raw of rawOps) {
    const parsed = opSchema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as any)?.id;
      out.push({ id: typeof id === 'string' ? id : '00000000-0000-0000-0000-000000000000', result: 'rejected', code: 'validation_failed', message: 'Opération mal formée' });
      continue;
    }
    const op = parsed.data as Operation;
    const refs = ['visit_id', 'company_id', 'contact_id'].map(k => (op.payload as any)[k]).filter(Boolean) as string[];
    const result = await tx(pool, async c => {
      const prev = (await c.query(`SELECT user_id, detail FROM client_operation WHERE id = $1`, [op.id])).rows[0];
      if (prev) {
        if (prev.user_id !== userId) return { id: op.id, result: 'rejected', code: 'forbidden', message: 'Opération inconnue' } as OperationResult;
        return prev.detail.result as OperationResult;   // rejeu : même résultat, aucun effet
      }
      let res: OperationResult;
      let detail: Record<string, unknown> = {};
      await c.query('SAVEPOINT op');
      try {
        if (failed.has(op.entity_id) || refs.some(r => failed.has(r))) throw new Reject('dependency_failed', 'Une opération dont celle-ci dépend a échoué');
        const a = await handle({ c, userId, op });
        res = { id: op.id, result: a.conflicts?.length ? 'conflict' : 'applied', version: a.version };
        if (a.conflicts?.length) res.conflict = { server_version: a.serverVersion ?? a.version ?? 0, fields: a.conflicts };
        detail = { version_after: a.version ?? null, applied_fields: a.fields };
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT op');
        if (!(e instanceof Reject)) throw e;
        res = { id: op.id, result: 'rejected', code: e.code, message: e.message };
      }
      await c.query(
        `INSERT INTO client_operation(id, user_id, device_id, entity, entity_id, op, payload, result, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [op.id, userId, deviceId, op.entity, op.entity_id, op.op, op.payload, res.result, { ...detail, result: res }]);
      return res;
    });
    if (result.result === 'rejected' && op.op === 'create') failed.add(op.entity_id);
    out.push(result);
  }
  return out;
}

export { VERSIONED };
export type { EntityName };
