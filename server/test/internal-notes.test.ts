import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, op, uuid, setMode, createServiceKey, Api, M, type TestEnv, type Fixture } from './helpers.js';

let env: TestEnv; let f: Fixture; let visit: string;
const SECRET = 'INFO-INTERNE-CONFIDENTIELLE-77';
before(async () => {
  env = await setup(); f = await fixture(env);
  visit = uuid();
  const c1 = await f.login('c1@x.fr');
  const r = await c1.push([op('visit', 'create', visit, { company_id: f.f1, status: 'in_progress' })]);
  assert.equal(r.body.results[0].result, 'applied');
});
after(async () => { await env.close(); });

const internalOf = async (who: string) => ((await (await f.login(who)).pullAll()).changes.internal_notes ?? []).filter(n => n.visit_id === visit && !n.deleted_at);

test('note interne : l\'auteur la lit, sa hiérarchie aussi (manager, directeur) ; personne d\'autre, quel que soit le mode de visibilité', async () => {
  const c1 = await f.login('c1@x.fr');
  const id = uuid();
  assert.equal((await c1.push([op('internal_note', 'create', id, { visit_id: visit, body: SECRET })])).body.results[0].result, 'applied');
  for (const mode of [2, 1] as const) {
    await setMode(env.pool, mode);
    const seen = Object.fromEntries(await Promise.all(['c1@x.fr', 'mgr1@x.fr', 'dir@x.fr', 'c2@x.fr', 'c3@x.fr', 'mgr2@x.fr', 'admin@x.fr'].map(async w => [w, (await internalOf(w)).length])));
    assert.deepEqual(seen, { 'c1@x.fr': 1, 'mgr1@x.fr': 1, 'dir@x.fr': 1, 'c2@x.fr': 0, 'c3@x.fr': 0, 'mgr2@x.fr': 0, 'admin@x.fr': 0 }, `mode ${mode}`);
  }
  const mine = (await internalOf('c1@x.fr'))[0]!;
  assert.equal(mine.body, SECRET); assert.equal(mine.author_name, 'c1');
  assert.equal((await internalOf('mgr1@x.fr'))[0]!.author_name, 'c1', 'la hiérarchie voit l\'auteur');
  await setMode(env.pool, 2);
});

test('note interne : jamais dans l\'API du CRM ni dans les notes durant visite', async () => {
  const key = await createServiceKey(env.pool);
  for (const path of ['visits', 'reports', 'notes', 'actions', 'visit-history']) {
    const r = await new Api(env.base).call('GET', `/api/crm/v1/${path}`, undefined, { authorization: `Bearer ${key}` });
    assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.body).includes(SECRET), path);
  }
  const { changes } = await (await f.login('mgr1@x.fr')).pullAll();
  assert.ok(!JSON.stringify(changes.notes ?? []).includes(SECRET), 'distincte des notes durant visite');
});

test('note interne : écriture réservée aux commerciaux qui voient la visite ; modification et suppression par l\'auteur seul', async () => {
  const id = (await internalOf('c1@x.fr'))[0]!.id;
  const w = async (who: string, o: object) => (await (await f.login(who)).push([o])).body.results[0];
  // manager et directeur : lecture seule
  assert.equal((await w('mgr1@x.fr', op('internal_note', 'update', id, { body: 'x' }))).code, 'forbidden');
  assert.equal((await w('mgr1@x.fr', op('internal_note', 'delete', id, {}))).code, 'forbidden');
  assert.equal((await w('mgr1@x.fr', op('internal_note', 'create', uuid(), { visit_id: visit, body: 'x' }))).code, 'forbidden', 'un manager n\'écrit pas de note interne');
  // qui ne la voit pas ne la connaît pas ; ne voit pas la visite : inconnue
  assert.equal((await w('c2@x.fr', op('internal_note', 'update', id, { body: 'x' }))).code, 'not_found');
  assert.equal((await w('c3@x.fr', op('internal_note', 'create', uuid(), { visit_id: visit, body: 'x' }))).code, 'not_found', 'mode 2 : visite invisible');
  // validation
  assert.equal((await w('c1@x.fr', op('internal_note', 'create', uuid(), { visit_id: visit, body: '   ' }))).code, 'validation_failed');
  // l'auteur modifie puis supprime
  assert.equal((await w('c1@x.fr', op('internal_note', 'update', id, { body: 'Corrigée' }))).result, 'applied');
  assert.equal((await internalOf('mgr1@x.fr'))[0]!.body, 'Corrigée', 'la hiérarchie voit la correction');
  assert.equal((await w('c1@x.fr', op('internal_note', 'delete', id, {}))).result, 'applied');
  assert.equal((await internalOf('c1@x.fr')).length, 0);
  const tomb = ((await (await f.login('mgr1@x.fr')).pullAll()).changes.internal_notes ?? []).find(n => n.id === id);
  assert.ok(tomb?.deleted_at, 'la suppression est transmise à la hiérarchie');
});

test('note interne : un autre commercial qui voit la visite (mode 1) peut écrire la sienne ; elle est lue par SA hiérarchie, pas par celle de l\'auteur de la visite', async () => {
  await setMode(env.pool, 1);
  const id = uuid();
  const r = (await (await f.login('c3@x.fr')).push([op('internal_note', 'create', id, { visit_id: visit, body: 'Vu par l\'équipe de c3' })])).body.results[0];
  assert.equal(r.result, 'applied');
  assert.equal((await internalOf('mgr2@x.fr')).some(n => n.id === id), true, 'manager de c3');
  assert.equal((await internalOf('mgr1@x.fr')).some(n => n.id === id), false, 'pas le manager de c1');
  assert.equal((await internalOf('c1@x.fr')).some(n => n.id === id), false, 'ni c1 lui-même');
  assert.equal((await internalOf('dir@x.fr')).some(n => n.id === id), true, 'le directeur est au-dessus des deux');
  await setMode(env.pool, 2);
});

test('note interne : changement de supérieur : l\'ancien manager reçoit un retrait d\'accès, le nouveau la reçoit', async () => {
  const c1 = await f.login('c1@x.fr'); const id = uuid();
  await c1.push([op('internal_note', 'create', id, { visit_id: visit, body: 'Pour la hiérarchie' })]);
  const mgr1 = await f.login('mgr1@x.fr'); const first = await mgr1.pullAll();
  assert.ok(first.changes.internal_notes?.some(n => n.id === id));
  const admin = await f.login('admin@x.fr');
  assert.equal((await admin.call('PATCH', `/api/admin/v1/users/${f.c1}`, { manager_id: f.mgr2 })).status, 200);
  const next = await mgr1.pullAll(first.cursor);
  assert.ok(next.revocations.some(r => r.entity === 'internal_note' && r.entity_id === id), 'ancien manager : retrait');
  assert.ok((await internalOf('mgr2@x.fr')).some(n => n.id === id), 'nouveau manager : lecture');
});

test('notes durant visite : l\'auteur modifie ou supprime ; un autre ne le peut pas ; la suppression est transmise', async () => {
  const c1 = await f.login('c1@x.fr'); const n = uuid();
  await c1.push([op('note', 'create', n, { visit_id: visit, kind: 'text', body: 'Brouillon' })]);
  assert.equal((await c1.push([op('note', 'update', n, { body: 'Version corrigée' })])).body.results[0].result, 'applied');
  const other = (await (await f.login('mgr2@x.fr')).push([op('note', 'update', n, { body: 'x' })])).body.results[0];
  assert.equal(other.result, 'rejected');   // visite devenue visible à mgr2 par le changement de supérieur, mais la note n'est pas la sienne
  assert.ok(['forbidden', 'not_found'].includes(other.code));
  const body = (await env.pool.query(`SELECT body, deleted_at FROM visit_note WHERE id = $1`, [n])).rows[0];
  assert.equal(body.body, 'Version corrigée');
  assert.equal((await c1.push([op('note', 'delete', n, {})])).body.results[0].result, 'applied');
  const tomb = ((await (await f.login('mgr2@x.fr')).pullAll()).changes.notes ?? []).find(x => x.id === n);
  assert.ok(tomb?.deleted_at, 'suppression transmise');
});
