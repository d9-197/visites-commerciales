import * as SQLite from 'expo-sqlite';
import { SqliteStore, type SqlDb } from '@visites/sync-core';

/** Adaptateur expo-sqlite -> SqlDb. Chiffrement de la base (SQLCipher) : non fait dans ce prototype. */
export async function openStore(name = 'visites.db'): Promise<SqliteStore> {
  const db = await SQLite.openDatabaseAsync(name);
  const adapter: SqlDb = {
    execAsync: sql => db.execAsync(sql),
    runAsync: (sql, params = []) => db.runAsync(sql, params),
    getFirstAsync: (sql, params = []) => db.getFirstAsync(sql, params),
    getAllAsync: (sql, params = []) => db.getAllAsync(sql, params),
    withTransactionAsync: task => db.withTransactionAsync(task),
  };
  return SqliteStore.open(adapter);
}
