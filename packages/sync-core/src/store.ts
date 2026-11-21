import type { ChangeKey, Operation, Row } from './types';

/** Stockage local de l'appareil. Deux implémentations : mémoire (tests) et SQLite (application). */
export interface Store {
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string | undefined): Promise<void>;
  upsert(table: ChangeKey, rows: Row[]): Promise<void>;
  remove(table: ChangeKey, id: string): Promise<void>;
  get(table: ChangeKey, id: string): Promise<Row | undefined>;
  list(table: ChangeKey): Promise<Row[]>;
  clearData(): Promise<void>;                      // vide les tables de données (pas la file d'opérations)
  enqueue(op: Operation): Promise<void>;
  replaceQueued(op: Operation): Promise<void>;     // remplace une opération en attente (fusion)
  pending(limit: number): Promise<Operation[]>;    // dans l'ordre de création
  pendingFor(entity: string, entityId: string): Promise<Operation[]>;
  removePending(opId: string): Promise<void>;
  pendingCount(): Promise<number>;
}

/** Clé primaire locale d'une ligne (certaines tables n'ont pas de colonne id). */
export function rowKey(table: ChangeKey, row: Row): string {
  if (table === 'assignments') return `${row.company_id}:${row.user_id}`;
  if (table === 'visit_contacts') return `${row.visit_id}:${row.contact_id}`;
  return row.id as string;
}

export class MemoryStore implements Store {
  private meta = new Map<string, string>();
  private tables = new Map<ChangeKey, Map<string, Row>>();
  private queue: Operation[] = [];

  async getMeta(k: string) { return this.meta.get(k); }
  async setMeta(k: string, v: string | undefined) { if (v === undefined) this.meta.delete(k); else this.meta.set(k, v); }
  private t(table: ChangeKey) { let m = this.tables.get(table); if (!m) { m = new Map(); this.tables.set(table, m); } return m; }
  async upsert(table: ChangeKey, rows: Row[]) { for (const r of rows) this.t(table).set(rowKey(table, r), { ...r }); }
  async remove(table: ChangeKey, id: string) { this.t(table).delete(id); }
  async get(table: ChangeKey, id: string) { const r = this.t(table).get(id); return r ? { ...r } : undefined; }
  async list(table: ChangeKey) { return [...this.t(table).values()].map(r => ({ ...r })); }
  async clearData() { this.tables.clear(); }
  async enqueue(op: Operation) { this.queue.push(structuredClone(op)); }
  async replaceQueued(op: Operation) { const i = this.queue.findIndex(q => q.id === op.id); if (i >= 0) this.queue[i] = structuredClone(op); }
  async pending(limit: number) { return this.queue.slice(0, limit).map(o => structuredClone(o)); }
  async pendingFor(entity: string, entityId: string) { return this.queue.filter(o => o.entity === entity && o.entity_id === entityId).map(o => structuredClone(o)); }
  async removePending(id: string) { this.queue = this.queue.filter(o => o.id !== id); }
  async pendingCount() { return this.queue.length; }

  /** Instantané sérialisable (persistance dans le navigateur). */
  snapshot(): string {
    return JSON.stringify({ meta: [...this.meta], tables: [...this.tables].map(([k, m]) => [k, [...m]]), queue: this.queue });
  }
  restore(json: string) {
    const d = JSON.parse(json);
    this.meta = new Map(d.meta);
    this.tables = new Map(d.tables.map(([k, rows]: [ChangeKey, [string, Row][]]) => [k, new Map(rows)]));
    this.queue = d.queue;
  }
}
