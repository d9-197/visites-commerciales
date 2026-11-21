import { rowKey, type Store } from './store';
import type { ChangeKey, Operation, Row } from './types';

/** Sous-ensemble de l'API SQLite dont le stockage a besoin : adaptateurs pour expo-sqlite (application) et node:sqlite (tests). */
export interface SqlDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: (string | number | null)[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params?: (string | number | null)[]): Promise<T | null | undefined>;
  getAllAsync<T>(sql: string, params?: (string | number | null)[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

/**
 * Stockage local sur SQLite : lignes en JSON (une table générique), file d'opérations ordonnée, métadonnées.
 * NON FAIT dans ce prototype : chiffrement de la base (SQLCipher) ; à traiter et à vérifier sur appareil.
 */
export class SqliteStore implements Store {
  private constructor(private db: SqlDb) {}

  static async open(db: SqlDb): Promise<SqliteStore> {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS data (tbl TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (tbl, id));
      CREATE TABLE IF NOT EXISTS queue (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS queue_entity ON queue(entity, entity_id);
    `);
    return new SqliteStore(db);
  }

  async getMeta(k: string) { return (await this.db.getFirstAsync<{ v: string }>('SELECT v FROM meta WHERE k = ?', [k]))?.v; }
  async setMeta(k: string, v: string | undefined) {
    if (v === undefined) await this.db.runAsync('DELETE FROM meta WHERE k = ?', [k]);
    else await this.db.runAsync('INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, v]);
  }
  async upsert(table: ChangeKey, rows: Row[]) {
    await this.db.withTransactionAsync(async () => {
      for (const r of rows) {
        await this.db.runAsync('INSERT INTO data(tbl, id, json) VALUES (?, ?, ?) ON CONFLICT(tbl, id) DO UPDATE SET json = excluded.json', [table, rowKey(table, r), JSON.stringify(r)]);
      }
    });
  }
  async remove(table: ChangeKey, id: string) { await this.db.runAsync('DELETE FROM data WHERE tbl = ? AND id = ?', [table, id]); }
  async get(table: ChangeKey, id: string) {
    const r = await this.db.getFirstAsync<{ json: string }>('SELECT json FROM data WHERE tbl = ? AND id = ?', [table, id]);
    return r ? (JSON.parse(r.json) as Row) : undefined;
  }
  async list(table: ChangeKey) {
    return (await this.db.getAllAsync<{ json: string }>('SELECT json FROM data WHERE tbl = ?', [table])).map(r => JSON.parse(r.json) as Row);
  }
  async clearData() { await this.db.runAsync('DELETE FROM data'); }
  async enqueue(op: Operation) {
    await this.db.runAsync('INSERT INTO queue(id, entity, entity_id, json) VALUES (?, ?, ?, ?)', [op.id, op.entity, op.entity_id, JSON.stringify(op)]);
  }
  async replaceQueued(op: Operation) { await this.db.runAsync('UPDATE queue SET json = ? WHERE id = ?', [JSON.stringify(op), op.id]); }
  async pending(limit: number) {
    return (await this.db.getAllAsync<{ json: string }>('SELECT json FROM queue ORDER BY n LIMIT ?', [limit])).map(r => JSON.parse(r.json) as Operation);
  }
  async pendingFor(entity: string, entityId: string) {
    return (await this.db.getAllAsync<{ json: string }>('SELECT json FROM queue WHERE entity = ? AND entity_id = ? ORDER BY n', [entity, entityId])).map(r => JSON.parse(r.json) as Operation);
  }
  async removePending(opId: string) { await this.db.runAsync('DELETE FROM queue WHERE id = ?', [opId]); }
  async pendingCount() { return (await this.db.getFirstAsync<{ n: number }>('SELECT count(*) AS n FROM queue'))?.n ?? 0; }
  /** Déconnexion : on efface tout ce qui est sur l'appareil, file comprise. */
  async wipe() { await this.db.execAsync('DELETE FROM data; DELETE FROM queue; DELETE FROM meta;'); }
}
