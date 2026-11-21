import pg from 'pg';

// bigint -> nombre (les numéros de changement restent très en dessous de 2^53) ; date -> chaîne AAAA-MM-JJ
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1700, (v: string) => Number(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 20 });
}

export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
