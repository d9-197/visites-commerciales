import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { createPool, type Pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { defaultConfig, type Config } from '../src/config.js';
import { hashPassword, sha256 } from '../src/auth.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
const SCHEMA = readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8');

export interface TestEnv { pool: Pool; base: string; close: () => Promise<void>; cfg: Config }

/** Base de données neuve (schéma complet) + serveur HTTP sur un port libre. */
export async function setup(over: Partial<Config> = {}): Promise<TestEnv> {
  const name = `vc_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL); url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  await pool.query(SCHEMA);
  const cfg = { ...defaultConfig, syncOverlap: 5, ...over };
  const server: Server = createApp(pool, cfg).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    pool, base, cfg,
    close: async () => {
      await new Promise(r => server.close(r));
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect(); await a.query(`DROP DATABASE ${name} WITH (FORCE)`); await a.end();
    },
  };
}

export const PASSWORD = 'mot-de-passe-de-test-12';
let hashed: string | undefined;

export async function createUser(pool: Pool, email: string, role: 'commercial' | 'manager' | 'directeur', managerId?: string, isAdmin = false) {
  hashed ??= await hashPassword(PASSWORD);
  const r = await pool.query(
    `INSERT INTO app_user(email, display_name, role, manager_id, is_admin, password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [email, email.split('@')[0], role, managerId ?? null, isAdmin, hashed]);
  await pool.query('SELECT rebuild_hierarchy()');
  return r.rows[0].id as string;
}

export async function createCompany(pool: Pool, crmId: string, assigned: string[], name = crmId) {
  const id = (await pool.query(`INSERT INTO company(crm_id, name) VALUES ($1,$2) RETURNING id`, [crmId, name])).rows[0].id as string;
  for (const u of assigned) await pool.query(`INSERT INTO company_assignment(company_id, user_id) VALUES ($1,$2)`, [id, u]);
  return id;
}

export async function createContact(pool: Pool, companyId: string, crmId: string) {
  return (await pool.query(`INSERT INTO contact(crm_id, company_id, full_name) VALUES ($1,$2,$1) RETURNING id`, [crmId, companyId])).rows[0].id as string;
}

export async function createServiceKey(pool: Pool, key = 'cle-crm-de-test') {
  await pool.query(`INSERT INTO service_account(name, key_prefix, key_hash) VALUES ('crm', $1, $2)`, [key.slice(0, 6), sha256(key)]);
  return key;
}

export const setMode = (pool: Pool, mode: 1 | 2) =>
  pool.query(`UPDATE app_setting SET value = to_jsonb($1::text) WHERE key = 'report_visibility_mode'`, [String(mode)]);

/** Client HTTP minimal, avec jetons et rotation. */
export class Api {
  token = ''; refresh = ''; deviceId = '';
  constructor(public base: string, public appVersion = '1.0.0') {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(this.base + path, {
      method, headers: { 'content-type': 'application/json', 'x-app-version': this.appVersion, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  async login(email: string, password = PASSWORD, deviceId?: string) {
    const r = await this.call('POST', '/api/mobile/v1/auth/login', {
      email, password, device: { platform: 'ios', app_version: this.appVersion, ...(deviceId ? { device_id: deviceId } : {}) },
    });
    if (r.status === 200) { this.token = r.body.access_token; this.refresh = r.body.refresh_token; this.deviceId = r.body.device_id; }
    return r;
  }
  pull(cursor?: string, limit?: number) {
    const q = new URLSearchParams(); if (cursor) q.set('cursor', cursor); if (limit) q.set('limit', String(limit));
    return this.call('GET', `/api/mobile/v1/sync/pull?${q}`);
  }
  push(operations: unknown[]) { return this.call('POST', '/api/mobile/v1/sync/push', { device_id: this.deviceId, operations }); }

  /** Lit tout jusqu'à la fin et renvoie toutes les lignes reçues + le dernier curseur. */
  async pullAll(cursor?: string) {
    const all: Record<string, any[]> = {}; const revocations: any[] = [];
    let c = cursor;
    for (;;) {
      const r = await this.pull(c, 50);
      if (r.status !== 200) throw new Error(`pull ${r.status} ${JSON.stringify(r.body)}`);
      for (const [k, rows] of Object.entries<any[]>(r.body.changes)) (all[k] ??= []).push(...rows);
      revocations.push(...r.body.revocations);
      c = r.body.next_cursor;
      if (!r.body.has_more) return { changes: all, revocations, cursor: c! };
    }
  }
}

export const op = (entity: string, kind: 'create' | 'update' | 'delete', entityId: string, payload: Record<string, unknown>, baseVersion?: number, id = randomUUID()) =>
  ({ id, entity, entity_id: entityId, op: kind, payload, ...(baseVersion !== undefined ? { base_version: baseVersion } : {}) });

export const uuid = randomUUID;
export const M = '/api/mobile/v1';

/** Jeu de données commun : dir > (mgr1 > c1, c2) et (mgr2 > c3) ; le client f1 est affecté à c1 et c3. */
export async function fixture(env: TestEnv) {
  const { pool, base } = env;
  const dir = await createUser(pool, 'dir@x.fr', 'directeur');
  const mgr1 = await createUser(pool, 'mgr1@x.fr', 'manager', dir);
  const mgr2 = await createUser(pool, 'mgr2@x.fr', 'manager', dir);
  const c1 = await createUser(pool, 'c1@x.fr', 'commercial', mgr1);
  const c2 = await createUser(pool, 'c2@x.fr', 'commercial', mgr1);
  const c3 = await createUser(pool, 'c3@x.fr', 'commercial', mgr2);
  const admin = await createUser(pool, 'admin@x.fr', 'commercial', undefined, true);
  const f1 = await createCompany(pool, 'CRM-F1', [c1, c3], 'Dupont SA');
  const contact = await createContact(pool, f1, 'CT-1');
  const login = async (email: string, deviceId?: string) => { const a = new Api(base); const r = await a.login(email, PASSWORD, deviceId); if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`); return a; };
  return { dir, mgr1, mgr2, c1, c2, c3, admin, f1, contact, login };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
