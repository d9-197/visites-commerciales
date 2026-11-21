import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, op, uuid, createServiceKey, insertAction, Api, type TestEnv, type Fixture } from './helpers.js';
import { importCrm } from '../src/crm-import.js';

let env: TestEnv; let f: Fixture; let key: string; let crm: (p: string) => Promise<{ status: number; body: any }>;
before(async () => {
  env = await setup(); f = await fixture(env); key = await createServiceKey(env.pool);
  crm = p => new Api(env.base).call('GET', `/api/crm/v1${p}`, undefined, { authorization: `Bearer ${key}` });
});
after(async () => { await env.close(); });

test('API CRM : sans clé ou avec une clé inconnue : 401 ; /health ouvert', async () => {
  const anon = new Api(env.base);
  assert.equal((await anon.call('GET', '/api/crm/v1/visits')).status, 401);
  assert.equal((await anon.call('GET', '/api/crm/v1/visits', undefined, { authorization: 'Bearer inconnue' })).status, 401);
  assert.equal((await anon.call('GET', '/api/crm/v1/health')).status, 200);
});

test('API CRM : une clé révoquée est refusée ; deux clés valides en même temps (renouvellement)', async () => {
  const second = await createServiceKey(env.pool, 'seconde-cle-de-test');
  assert.equal((await new Api(env.base).call('GET', '/api/crm/v1/visits', undefined, { authorization: `Bearer ${second}` })).status, 200);
  assert.equal((await crm('/visits')).status, 200);
  await env.pool.query(`UPDATE service_account SET revoked_at = now() WHERE key_prefix = 'second'`);
  assert.equal((await new Api(env.base).call('GET', '/api/crm/v1/visits', undefined, { authorization: `Bearer ${second}` })).status, 401);
});

test('API CRM : comptes rendus validés seulement ; suppressions logiques visibles ; actions annulées incluses', async () => {
  const a = await f.login('c1@x.fr');
  const v = uuid(), draft = uuid(), valid = uuid(), v2 = uuid(), n = uuid(), act = uuid();
  await a.push([
    op('visit', 'create', v, { company_id: f.f1 }), op('report', 'create', draft, { visit_id: v, language: 'fr', summary: 'brouillon' }),
    op('visit', 'create', v2, { company_id: f.f1, status: 'done' }), op('report', 'create', valid, { visit_id: v2, language: 'fr', summary: 'validé', status: 'validated' }),
    op('note', 'create', n, { visit_id: v, kind: 'text', body: 'à supprimer' }),
  ]);
  await insertAction(env.pool, { id: act, company: f.f1, visit: v, author: f.c1, title: 'À annuler' });
  await a.push([op('note', 'delete', n, {}), op('action', 'update', act, { status: 'cancelled' }, 1)]);

  const reports = (await crm('/reports')).body.items.map((r: any) => r.id);
  assert.ok(reports.includes(valid)); assert.ok(!reports.includes(draft), 'les brouillons ne sont pas exposés');
  const notes = (await crm('/notes')).body.items;
  assert.ok(notes.find((x: any) => x.id === n)?.deleted_at, 'la suppression est visible pour le CRM');
  assert.ok(!(await crm('/notes?include_deleted=false')).body.items.some((x: any) => x.id === n));
  const acts = (await crm('/actions')).body.items;
  const cancelled = acts.find((x: any) => x.id === act);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.company_crm_id, 'CRM-F1');
  assert.equal(cancelled.owner_email, 'c1@x.fr');
  const one = await crm(`/visits/${v}`);
  assert.equal(one.status, 200); assert.equal(one.body.author_email, 'c1@x.fr');
});

test('API CRM : lecture incrémentale par curseur, pagination sans perte', async () => {
  const a = await f.login('c1@x.fr');
  await a.push(Array.from({ length: 5 }, () => op('visit', 'create', uuid(), { company_id: f.f1 })));
  const total = (await crm('/visits?limit=1000')).body.items.length;
  const first = await crm('/visits?limit=2');
  assert.equal(first.body.items.length, 2); assert.equal(first.body.has_more, true);
  const seen = new Set<string>(first.body.items.map((x: any) => x.id));
  let cursor = first.body.next_cursor;
  for (let i = 0; i < 50; i++) {
    const p = await crm(`/visits?limit=2&cursor=${cursor}`);
    p.body.items.forEach((x: any) => seen.add(x.id));
    cursor = p.body.next_cursor;
    if (!p.body.has_more) break;
  }
  assert.equal(seen.size, total);
  // un changement ultérieur apparaît à la lecture suivante, sans tout relire
  const nv = uuid();
  await a.push([op('visit', 'create', nv, { company_id: f.f1 })]);
  const delta = await crm(`/visits?cursor=${cursor}`);
  assert.ok(delta.body.items.some((x: any) => x.id === nv));
});

test('import CRM : crée clients, contacts et affectations ; marque inactif un client absent ; retire l\'accès', async () => {
  const imp = await importCrm(env.pool, [
    { crm_id: 'N1', name: 'Nouveau client', city: 'Lyon', contacts: [{ crm_id: 'NC1', full_name: 'M. Neuf', email: 'neuf@x.fr' }], sales_emails: ['c2@x.fr'] },
  ], { fullList: false });
  assert.equal(imp.result.companies, 1);
  const c2 = await f.login('c2@x.fr');
  const got = await c2.pullAll();
  const n1 = got.changes.companies!.find(c => c.name === 'Nouveau client');
  assert.ok(n1);
  assert.equal(got.changes.contacts!.some(c => c.full_name === 'M. Neuf'), true);

  // le CRM retire c2 des commerciaux du client : l'appareil reçoit le retrait
  const rem = await importCrm(env.pool, [{ crm_id: 'N1', name: 'Nouveau client', contacts: [], sales_emails: [] }]);
  assert.ok(rem.revoked > 0);
  const next = await c2.pullAll(got.cursor);
  assert.ok(next.revocations.some(r => r.entity === 'company' && r.entity_id === n1!.id));

  // liste complète sans N1 : client marqué inactif, pas supprimé
  const full = await importCrm(env.pool, [{ crm_id: 'CRM-F1', name: 'Dupont SA', contacts: [], sales_emails: ['c1@x.fr', 'c3@x.fr'] }], { fullList: true });
  assert.equal(full.result.deactivated, 1);
  const st = (await env.pool.query(`SELECT status, deleted_at FROM company WHERE crm_id = 'N1'`)).rows[0];
  assert.equal(st.status, 'inactive'); assert.equal(st.deleted_at, null);
});
