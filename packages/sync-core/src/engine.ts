import type { ChangeKey, EntityName, Operation, OperationResult, PullResponse, Row } from './types';
import { CHANGE_KEY, VERSIONED } from './types';
import { rowKey, type Store } from './store';

export class NetworkError extends Error { constructor(m = 'Réseau indisponible') { super(m); } }
export class ApiError extends Error { constructor(public status: number, public code: string, m?: string) { super(m ?? code); } }

export interface Transport {
  push(operations: Operation[]): Promise<OperationResult[]>;
  pull(cursor: string | undefined, limit: number): Promise<PullResponse>;
}

export interface SyncReport {
  offline: boolean;
  pushed: number;
  conflicts: { op: Operation; result: OperationResult }[];
  rejected: { op: Operation; result: OperationResult }[];
  pulled: number;
  revoked: number;
  resynced: boolean;
}

const KEY_TO_ENTITY: Partial<Record<ChangeKey, EntityName>> = Object.fromEntries(
  Object.entries(CHANGE_KEY).map(([e, k]) => [k, e])) as Partial<Record<ChangeKey, EntityName>>;

/**
 * Moteur de synchronisation hors-ligne.
 *  - Écritures : appliquées tout de suite en local, ajoutées à une file d'opérations ; plusieurs modifications de la même
 *    entité sont fusionnées en une seule opération (sinon un appareil entrerait en conflit avec lui-même).
 *  - Synchro : envoi de la file (par lots de 200), puis lecture des changements du serveur jusqu'à la fin.
 *  - Une ligne reçue ne remplace pas une ligne locale qui a une opération en attente.
 */
export class SyncEngine {
  constructor(private store: Store, private transport: Transport, private ids: { newId: () => string; userId: string; now?: () => string }) {}

  private now() { return (this.ids.now ?? (() => new Date().toISOString()))(); }
  private tableOf(entity: EntityName): ChangeKey {
    const k = CHANGE_KEY[entity];
    if (!k) throw new Error(`Entité sans table locale : ${entity}`);
    return k;
  }

  /** Création locale ; renvoie l'identifiant généré sur l'appareil. */
  async create(entity: EntityName, payload: Row, id = this.ids.newId()): Promise<string> {
    const table = this.tableOf(entity);
    const base: Row = { id, version: 1, updated_at: this.now() };
    if (entity === 'visit' || entity === 'note') base.author_id = this.ids.userId;
    if (entity === 'action') { base.author_id = this.ids.userId; base.owner_id = this.ids.userId; base.status = 'todo'; base.reminder = 'none'; }
    await this.store.upsert(table, [{ ...base, ...payload }]);
    await this.store.enqueue({ id: this.ids.newId(), entity, entity_id: id, op: 'create', payload });
    return id;
  }

  async update(entity: EntityName, id: string, changes: Row): Promise<void> {
    const table = this.tableOf(entity);
    const row = await this.store.get(table, id);
    if (!row) throw new Error(`${entity} ${id} inconnu`);
    await this.store.upsert(table, [{ ...row, ...changes, updated_at: this.now() }]);
    const queued = await this.store.pendingFor(entity, id);
    const last = queued[queued.length - 1];
    if (last && last.op !== 'delete') {       // fusion avec l'opération en attente (création ou modification)
      await this.store.replaceQueued({ ...last, payload: { ...last.payload, ...changes } });
      return;
    }
    await this.store.enqueue({
      id: this.ids.newId(), entity, entity_id: id, op: 'update', payload: changes,
      ...(VERSIONED.has(entity) ? { base_version: row.version as number } : {}),
    });
  }

  async remove(entity: EntityName, id: string): Promise<void> {
    const table = this.tableOf(entity);
    const queued = await this.store.pendingFor(entity, id);
    const createQueued = queued.find(o => o.op === 'create');
    for (const o of queued) await this.store.removePending(o.id);
    await this.store.remove(table, id);
    if (!createQueued) await this.store.enqueue({ id: this.ids.newId(), entity, entity_id: id, op: 'delete', payload: {} });
  }

  async sync(): Promise<SyncReport> {
    const rep: SyncReport = { offline: false, pushed: 0, conflicts: [], rejected: [], pulled: 0, revoked: 0, resynced: false };
    try {
      for (;;) {
        const ops = await this.store.pending(200);
        if (!ops.length) break;
        const results = await this.transport.push(ops);
        for (const [i, op] of ops.entries()) {
          const res = results[i];
          if (!res) break;
          await this.store.removePending(op.id);
          rep.pushed++;
          if (res.result === 'conflict') rep.conflicts.push({ op, result: res });
          if (res.result === 'rejected') {
            rep.rejected.push({ op, result: res });
            if (op.op === 'create' && CHANGE_KEY[op.entity]) await this.store.remove(this.tableOf(op.entity), op.entity_id);
          }
        }
      }
      await this.pullAll(rep);
    } catch (e) {
      if (e instanceof NetworkError) rep.offline = true; else throw e;
    }
    return rep;
  }

  private async pullAll(rep: SyncReport) {
    let cursor = await this.store.getMeta('cursor');
    for (;;) {
      let r: PullResponse;
      try { r = await this.transport.pull(cursor, 200); }
      catch (e) {
        if (e instanceof ApiError && e.code === 'cursor_expired') {   // curseur périmé : on repart de zéro
          await this.store.clearData(); await this.store.setMeta('cursor', undefined); cursor = undefined; rep.resynced = true; continue;
        }
        throw e;
      }
      await this.apply(r, rep);
      cursor = r.next_cursor;
      await this.store.setMeta('cursor', cursor);
      if (!r.has_more) return;
    }
  }

  private async apply(r: PullResponse, rep: SyncReport) {
    for (const [key, rows] of Object.entries(r.changes) as [ChangeKey, Row[]][]) {
      const entity = KEY_TO_ENTITY[key];
      for (const row of rows) {
        rep.pulled++;
        const pk = rowKey(key, row);
        if (entity && (await this.store.pendingFor(entity, row.id)).length) continue;   // modification locale en attente : on la garde
        if (row.deleted_at || row.removed_at) await this.store.remove(key, pk);
        else await this.store.upsert(key, [row]);
      }
    }
    for (const rv of r.revocations) { await this.revoke(rv.entity, rv.entity_id); rep.revoked++; }
  }

  /** Donnée devenue invisible : on la supprime avec ce qui en dépend. */
  private async revoke(entity: string, id: string) {
    if (entity === 'company') {
      await this.store.remove('companies', id);
      for (const t of ['contacts', 'assignments'] as ChangeKey[]) for (const r of await this.store.list(t)) if (r.company_id === id) await this.store.remove(t, rowKey(t, r));
    } else if (entity === 'visit') {
      await this.store.remove('visits', id);
      for (const t of ['reports', 'notes', 'private_notes', 'actions', 'visit_contacts', 'visit_history'] as ChangeKey[])
        for (const r of await this.store.list(t)) if (r.visit_id === id && (t !== 'actions')) await this.store.remove(t, rowKey(t, r));
    } else if (entity === 'action') await this.store.remove('actions', id);
  }
}
