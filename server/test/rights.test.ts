import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, op, uuid, setMode, createServiceKey, M, Api, type TestEnv, type Fixture } from './helpers.js';

let env: TestEnv; let f: Fixture;
let visit: string; let privNote: string; const SECRET = 'SECRET-NOTE-PRIVEE-42';
before(async () => {
  env = await setup(); f = await fixture(env);
  const c1 = await f.login('c1@x.fr');
  visit = uuid(); privNote = uuid();
  const r = await c1.push([
    op('visit', 'create', visit, { company_id: f.f1, status: 'in_progress' }),
    op('note', 'create', uuid(), { visit_id: visit, kind: 'text', body: 'Note publique' }),
    op('private_note', 'create', privNote, { visit_id: visit, body: SECRET }),
    op('visit', 'update', visit, { status: 'done' }, 1),                                    // les notes ne se modifient plus après
    op('report', 'create', uuid(), { visit_id: visit, language: 'fr', summary: 'Résumé public', status: 'validated', no_action: true }),
  ]);
  assert.deepEqual(r.body.results.map((x: any) => x.result), ['applied', 'applied', 'applied', 'applied', 'applied']);
});
after(async () => { await env.close(); });

const sees = async (email: string) => (await (await f.login(email)).pullAll()).changes.visits?.some(v => v.id === visit) ?? false;

test('scénario 5, mode 2 : auteur et hiérarchie seulement', async () => {
  await setMode(env.pool, 2);
  assert.deepEqual(
    { c1: await sees('c1@x.fr'), c2: await sees('c2@x.fr'), c3: await sees('c3@x.fr'), mgr1: await sees('mgr1@x.fr'), mgr2: await sees('mgr2@x.fr'), dir: await sees('dir@x.fr'), admin: await sees('admin@x.fr') },
    { c1: true, c2: false, c3: false, mgr1: true, mgr2: false, dir: true, admin: false });
});

test('scénario 5, mode 1 : plus les commerciaux du client et leur hiérarchie', async () => {
  await setMode(env.pool, 1);
  assert.deepEqual(
    { c1: await sees('c1@x.fr'), c2: await sees('c2@x.fr'), c3: await sees('c3@x.fr'), mgr1: await sees('mgr1@x.fr'), mgr2: await sees('mgr2@x.fr'), dir: await sees('dir@x.fr'), admin: await sees('admin@x.fr') },
    { c1: true, c2: false, c3: true, mgr1: true, mgr2: true, dir: true, admin: false });
  await setMode(env.pool, 2);
});

test('scénario 6 : la note privée n\'apparaît que chez son auteur, jamais ailleurs ni dans l\'API CRM', async () => {
  await setMode(env.pool, 1);
  for (const email of ['c3@x.fr', 'mgr1@x.fr', 'mgr2@x.fr', 'dir@x.fr', 'admin@x.fr']) {
    const { changes } = await (await f.login(email)).pullAll();
    assert.equal(changes.private_notes?.length ?? 0, 0, `${email} ne doit pas recevoir de note privée`);
    assert.ok(!JSON.stringify(changes).includes(SECRET), `${email} : le texte privé ne doit apparaître nulle part`);
  }
  const own = (await (await f.login('c1@x.fr')).pullAll()).changes;
  assert.equal(own.private_notes?.length, 1);
  assert.equal(own.private_notes![0].body, SECRET);
  // API du CRM : toutes les ressources, texte privé absent
  const key = await createServiceKey(env.pool);
  for (const path of ['visits', 'reports', 'notes', 'actions']) {
    const r = await new Api(env.base).call('GET', `/api/crm/v1/${path}`, undefined, { authorization: `Bearer ${key}` });
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
  }
  await setMode(env.pool, 2);
});

test('une note privée d\'un autre auteur est introuvable (404 logique), pas interdite', async () => {
  const c3 = await f.login('c3@x.fr');
  const r = await c3.push([op('private_note', 'update', privNote, { body: 'piratage' }, 1)]);
  assert.equal(r.body.results[0].result, 'rejected');
  assert.equal(r.body.results[0].code, 'not_found');
  const still = (await env.pool.query(`SELECT body FROM private_note WHERE id = $1`, [privNote])).rows[0].body;
  assert.equal(still, SECRET);
});

test('un commercial ne modifie ni la visite ni les actions d\'un collègue', async () => {
  await setMode(env.pool, 1);
  const c3 = await f.login('c3@x.fr');
  const r = await c3.push([op('visit', 'update', visit, { status: 'cancelled' }, 1), op('note', 'create', uuid(), { visit_id: visit, kind: 'text', body: 'x' })]);
  assert.equal(r.body.results[0].code, 'forbidden');
  assert.equal(r.body.results[1].code, 'forbidden');
  await setMode(env.pool, 2);
});

test('le client de l\'API mobile ne peut pas appeler l\'administration ; un administrateur le peut', async () => {
  const c1 = await f.login('c1@x.fr');
  assert.equal((await c1.call('PUT', '/api/admin/v1/settings', { report_visibility_mode: 1 })).status, 403);
  const admin = await f.login('admin@x.fr');
  const r = await admin.call('PUT', '/api/admin/v1/settings', { report_visibility_mode: 2 });
  assert.equal(r.status, 200);   // déjà en mode 2 : aucun impact, pas de confirmation requise
});

test('scénario 4 : retrait d\'une affectation : l\'appareil reçoit les retraits d\'accès', async () => {
  await setMode(env.pool, 1);
  const c3 = await f.login('c3@x.fr');
  const first = await c3.pullAll();
  assert.ok(first.changes.visits?.some(v => v.id === visit));
  assert.ok(first.changes.companies?.some(c => c.id === f.f1));

  const admin = await f.login('admin@x.fr');
  const r = await admin.call('PUT', `/api/admin/v1/companies/${f.f1}/assignments`, { user_ids: [f.c1] });   // c3 est retiré
  assert.equal(r.status, 200);
  assert.ok(r.body.revoked > 0);

  const next = await c3.pullAll(first.cursor);
  const kinds = next.revocations.map(x => `${x.entity}:${x.entity_id}`);
  assert.ok(kinds.includes(`company:${f.f1}`), 'client retiré');
  assert.ok(kinds.includes(`visit:${visit}`), 'visite retirée');
  // et c3 ne peut plus rien écrire sur ce client
  const w = await c3.push([op('action', 'create', uuid(), { company_id: f.f1, visit_id: visit, title: 'Interdit' })]);
  assert.equal(w.body.results[0].result, 'rejected');   // la visite n'est plus visible pour c3 : inconnue
  assert.equal(w.body.results[0].code, 'not_found');
  // rétablir pour les tests suivants
  await admin.call('PUT', `/api/admin/v1/companies/${f.f1}/assignments`, { user_ids: [f.c1, f.c3] });
  await setMode(env.pool, 2);
});

test('scénario 4 : changement de mode de visibilité : confirmation exigée, puis retraits d\'accès', async () => {
  await setMode(env.pool, 1);
  const mgr2 = await f.login('mgr2@x.fr');
  const first = await mgr2.pullAll();
  assert.ok(first.changes.visits?.some(v => v.id === visit));

  const admin = await f.login('admin@x.fr');
  const refused = await admin.call('PUT', '/api/admin/v1/settings', { report_visibility_mode: 2 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'impact_confirmation_required');
  assert.ok(refused.body.visits_becoming_hidden > 0);
  assert.equal((await env.pool.query(`SELECT visibility_mode() AS m`)).rows[0].m, 1, 'rien n\'a été modifié par la simple estimation');

  const ok = await admin.call('PUT', '/api/admin/v1/settings', { report_visibility_mode: 2, confirm_impact: true });
  assert.equal(ok.status, 200);
  const next = await mgr2.pullAll(first.cursor);
  assert.ok(next.revocations.some(x => x.entity === 'visit' && x.entity_id === visit));
});

test('changement de supérieur : la hiérarchie est reconstruite et les accès retirés', async () => {
  const mgr1 = await f.login('mgr1@x.fr');
  const first = await mgr1.pullAll();
  assert.ok(first.changes.visits?.some(v => v.id === visit));
  const admin = await f.login('admin@x.fr');
  const r = await admin.call('PATCH', `/api/admin/v1/users/${f.c1}`, { manager_id: f.mgr2 });   // c1 passe chez mgr2
  assert.equal(r.status, 200);
  const next = await mgr1.pullAll(first.cursor);
  assert.ok(next.revocations.some(x => x.entity === 'visit' && x.entity_id === visit));
  assert.ok((await (await f.login('mgr2@x.fr')).pullAll()).changes.visits?.some(v => v.id === visit));
  // cycle refusé : mgr2 ne peut pas avoir pour supérieur son propre subordonné c1
  const cyc = await admin.call('PATCH', `/api/admin/v1/users/${f.mgr2}`, { manager_id: f.c1 });
  assert.equal(cyc.status, 409);
  assert.equal(cyc.body.code, 'hierarchy_cycle');
});

void M;
