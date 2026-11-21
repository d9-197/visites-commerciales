import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, op, uuid, insertAction, type TestEnv, type Fixture } from './helpers.js';

let env: TestEnv; let f: Fixture;
before(async () => { env = await setup(); f = await fixture(env); });
after(async () => { await env.close(); });

const visitOp = (id: string, company: string, extra: Record<string, unknown> = {}) => op('visit', 'create', id, { company_id: company, status: 'planned', ...extra });

test('création hors-ligne d\'une visite et de son compte rendu validé : les actions prévues sont créées par le serveur, puis lecture', async () => {
  const a = await f.login('c1@x.fr');
  const v = uuid(), r = uuid(), act = uuid();
  const res = await a.push([
    visitOp(v, f.f1, { objective: 'Suivi offre B', planned_start: '2026-11-20T10:30:00Z', status: 'done' }),
    op('report', 'create', r, { visit_id: v, language: 'fr', summary: 'Intéressé par l\'offre B.', status: 'validated', draft_actions: [{ id: act, title: 'Envoyer le devis', due_date: '2026-11-26', origin: 'manual' }] }),
  ]);
  assert.deepEqual(res.body.results.map((x: any) => x.result), ['applied', 'applied']);
  const { changes } = await a.pullAll();
  assert.equal(changes.visits?.length, 1);
  assert.equal(changes.visits![0].status, 'validated', 'visite terminée + compte rendu validé');
  assert.equal(changes.reports![0].summary, 'Intéressé par l\'offre B.');
  assert.deepEqual(changes.reports![0].draft_actions, [], 'les actions prévues ont été converties');
  assert.equal(changes.actions!.length, 1); assert.equal(changes.actions![0].id, act);
  assert.equal(changes.actions![0].visit_id, v);
  assert.equal(changes.actions![0].due_date, '2026-11-26');
  assert.equal(changes.actions![0].owner_id, f.c1);   // responsable = auteur dans le MVP
  assert.equal(changes.companies?.[0]?.name, 'Dupont SA');
  assert.equal(changes.contacts?.length, 1);
});

test('scénario 1 : deux appareils, champs différents appliqués ; même champ court : le serveur l\'emporte', async () => {
  const a = await f.login('c1@x.fr'), b = await f.login('c1@x.fr');
  const v = uuid();
  await a.push([visitOp(v, f.f1, { location_text: 'Lyon' })]);
  // A et B modifient à partir de la version 1, hors-ligne
  const ra = await a.push([op('visit', 'update', v, { location_text: 'Lyon 3e' }, 1)]);
  assert.equal(ra.body.results[0].result, 'applied');
  assert.equal(ra.body.results[0].version, 2);
  const rb = await b.push([op('visit', 'update', v, { status: 'organized' }, 1)]);     // champ différent
  assert.equal(rb.body.results[0].result, 'applied');
  assert.equal(rb.body.results[0].version, 3);
  const rc = await b.push([op('visit', 'update', v, { location_text: 'Villeurbanne' }, 1)]); // même champ que A
  const c = rc.body.results[0];
  assert.equal(c.result, 'conflict');
  assert.equal(c.conflict.fields[0].field, 'location_text');
  assert.equal(c.conflict.fields[0].resolution, 'server_wins');
  const { changes } = await b.pullAll();
  const row = changes.visits!.find(x => x.id === v)!;
  assert.equal(row.location_text, 'Lyon 3e');
  assert.equal(row.status, 'organized');
});

test('scénario 2 : texte long modifié des deux côtés : les deux versions sont conservées', async () => {
  const a = await f.login('c1@x.fr'), b = await f.login('c1@x.fr');
  const v = uuid(), r = uuid();
  await a.push([visitOp(v, f.f1), op('report', 'create', r, { visit_id: v, language: 'fr', summary: 'Version initiale' })]);
  await a.push([op('report', 'update', r, { summary: 'Résumé écrit sur A' }, 1)]);
  const rb = await b.push([op('report', 'update', r, { summary: 'Résumé écrit sur B' }, 1)]);
  const res = rb.body.results[0];
  assert.equal(res.result, 'conflict');
  assert.equal(res.conflict.fields[0].resolution, 'both_kept');
  const kept = (await env.pool.query(`SELECT device_value, server_value FROM text_conflict WHERE entity_id = $1`, [r])).rows;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].device_value, 'Résumé écrit sur B');
  assert.equal(kept[0].server_value, 'Résumé écrit sur A');
});

test('scénario 3 : rejouer une opération ne crée aucun doublon ; même entité avec un autre identifiant d\'opération : refusée', async () => {
  const a = await f.login('c1@x.fr');
  const v = uuid(); const create = visitOp(v, f.f1);
  const r1 = await a.push([create]);
  const r2 = await a.push([create]);   // réponse perdue, l'application renvoie
  assert.deepEqual(r2.body.results, r1.body.results);
  const n = (await env.pool.query(`SELECT count(*)::int AS n FROM visit WHERE id = $1`, [v])).rows[0].n;
  assert.equal(n, 1);
  const r3 = await a.push([visitOp(v, f.f1)]);
  assert.equal(r3.body.results[0].result, 'rejected');
  assert.equal(r3.body.results[0].code, 'already_exists');
});

test('scénario 7 : reprise après coupure au milieu d\'un lot', async () => {
  const a = await f.login('c1@x.fr');
  const v = uuid(), n = uuid();
  const batch = [visitOp(v, f.f1), op('note', 'create', n, { visit_id: v, kind: 'text', body: 'Note 1' })];
  await a.push([batch[0]]);                 // seule la première opération est arrivée
  const full = await a.push(batch);         // l'application renvoie tout le lot
  assert.deepEqual(full.body.results.map((x: any) => x.result), ['applied', 'applied']);
  const counts = (await env.pool.query(`SELECT (SELECT count(*) FROM visit WHERE id=$1)::int v, (SELECT count(*) FROM visit_note WHERE id=$2)::int n`, [v, n])).rows[0];
  assert.deepEqual(counts, { v: 1, n: 1 });
});

test('une opération refusée n\'arrête pas les suivantes, sauf celles qui en dépendent', async () => {
  const a = await f.login('c2@x.fr');   // c2 n'est affecté à aucun client
  const v = uuid(), n = uuid(), act = uuid();
  const ok = (await f.login('c1@x.fr'));
  const res = await a.push([
    visitOp(v, f.f1),                                                  // refusée : client inaccessible
    op('note', 'create', n, { visit_id: v, kind: 'text', body: 'x' }), // dépend de la visite refusée
    op('action', 'create', act, { company_id: uuid(), title: 'Ailleurs' }), // indépendante, mais client inconnu
  ]);
  const r = res.body.results;
  assert.equal(r[0].result, 'rejected'); assert.equal(r[0].code, 'forbidden');
  assert.equal(r[1].code, 'dependency_failed');
  assert.equal(r[2].result, 'rejected');
  void ok;
});

test('validation du compte rendu : résumé non vide exigé ; visite terminée exigée ; un compte rendu validé se remet en brouillon', async () => {
  const a = await f.login('c1@x.fr');
  const v = uuid(), r = uuid();
  await a.push([visitOp(v, f.f1, { status: 'in_progress' }), op('report', 'create', r, { visit_id: v, language: 'fr' })]);
  const early = await a.push([op('report', 'update', r, { summary: 'Résumé', status: 'validated' }, 1)]);
  assert.equal(early.body.results[0].code, 'locked_status', 'visite pas terminée');
  await a.push([op('visit', 'update', v, { status: 'done' }, 1)]);
  const bad = await a.push([op('report', 'update', r, { status: 'validated' }, 1)]);
  assert.equal(bad.body.results[0].code, 'validation_failed', 'résumé requis');
  const ok = await a.push([op('report', 'update', r, { summary: 'Résumé', status: 'validated' }, 1)]);
  assert.equal(ok.body.results[0].result, 'applied');
  const back = await a.push([op('report', 'update', r, { status: 'draft' }, 2)]);
  assert.equal(back.body.results[0].result, 'applied', 'remise en brouillon autorisée');
});

test('action : terminer renseigne completed_at ; annuler est possible ; suppression refusée', async () => {
  const a = await f.login('c1@x.fr');
  const act = await insertAction(env.pool, { company: f.f1, author: f.c1, title: 'Appeler' });
  const done = await a.push([op('action', 'update', act, { status: 'done' }, 1)]);
  assert.equal(done.body.results[0].result, 'applied');
  const row = (await env.pool.query(`SELECT status, completed_at FROM action_item WHERE id = $1`, [act])).rows[0];
  assert.equal(row.status, 'done'); assert.ok(row.completed_at);
  const cancel = await a.push([op('action', 'update', act, { status: 'cancelled' }, 2)]);
  assert.equal(cancel.body.results[0].result, 'applied');
  const del = await a.push([op('action', 'delete', act, {})]);
  assert.equal(del.body.results[0].code, 'validation_failed');
});

test('entités non prises en charge par ce prototype : refusées proprement', async () => {
  const a = await f.login('c1@x.fr');
  const r = await a.push([op('recording', 'create', uuid(), { visit_id: uuid() })]);
  assert.equal(r.body.results[0].code, 'not_implemented');
});
