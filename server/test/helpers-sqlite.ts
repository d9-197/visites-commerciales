import { DatabaseSync } from 'node:sqlite';
import type { SqlDb } from '@visites/sync-core';

/** Même interface que l'adaptateur expo-sqlite, sur node:sqlite : permet de tester les requêtes SQL du stockage de l'appli. */
export function nodeSqlDb(): SqlDb {
  const db = new DatabaseSync(':memory:');
  return {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql, params = []) { db.prepare(sql).run(...params); },
    async getFirstAsync<T>(sql: string, params: (string | number | null)[] = []) { return db.prepare(sql).get(...params) as T | undefined; },
    async getAllAsync<T>(sql: string, params: (string | number | null)[] = []) { return db.prepare(sql).all(...params) as T[]; },
    async withTransactionAsync(task) { db.exec('BEGIN'); try { await task(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } },
  };
}
