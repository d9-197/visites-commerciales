import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, op, uuid, setMode, createServiceKey, validatedVisit, insertAction, Api, type TestEnv, type Fixture } from './helpers.js';
import { migrate } from '../src/migrate.js';
import pg from 'pg';
import { isReportLate, visitStage, needsNoActionAck, isDueBeforeVisit, canEditInternalNote } from '@visites/sync-core';

let env: TestEnv; let f: Fixture;
before(async () => { env = await setup(); f = await fixture(env); });
after(async () => { await env.close(); });

const newVisit = async (author = 'c1@x.fr', extra: Record<string, unknown> = {}) => {
  const a = await f.login(author); const v = uuid();
  const r = await a.push([op('visit', 'create', v, { company_id: f.f1, status: 'planned', location_text: '12 rue des Lilas', planned_start: '2026-11-26T10:00:00Z', ...extra })]);
  assert.equal(r.body.results[0].result, 'applied');
  return { a, v };
};
const upd = async (who: string, v: string, payload: Record<string, unknown>, base = 1) => (await (await f.login(who)).push([op('visit', 'update', v, payload, base)])).body.results[0];

test('adresse, visite « à organiser » : toute personne qui voit la visite peut la modifier (auteur, manager, directeur)', async () => {
  await setMode(env.pool, 2);
  const { v } = await newVisit();
  let version = 1;
  for (const who of ['mgr1@x.fr', 'dir@x.fr', 'c1@x.fr']) {
    const r = await upd(who, v, { location_text: `Adresse de ${who}` }, version);
    assert.equal(r.result, 'applied', who);
    version = r.version;
  }
  // une personne qui ne voit pas la visite (mode 2, autre équipe) ne la connaît pas
  const hidden = await upd('c3@x.fr', v, { location_text: 'x' }, version);
  assert.equal(hidden.code, 'not_found');
});

test('adresse, visite organisée : les commerciaux seulement ; manager et directeur refusés', async () => {
  await setMode(env.pool, 1);                                     // mode 1 : c3, affecté au client, voit la visite
  const { v } = await newVisit();
  const org = await upd('c1@x.fr', v, { status: 'organized' });
  assert.equal(org.result, 'applied');
  assert.equal((await upd('mgr1@x.fr', v, { location_text: 'par le manager' }, 2)).code, 'locked_status');
  assert.equal((await upd('dir@x.fr', v, { location_text: 'par le directeur' }, 2)).code, 'locked_status');
  const byCommercial = await upd('c3@x.fr', v, { location_text: 'par un autre commercial du client' }, 2);
  assert.equal(byCommercial.result, 'applied');
  assert.equal((await upd('c1@x.fr', v, { location_text: 'par l\'auteur' }, 3)).result, 'applied');
  await setMode(env.pool, 2);
});

test('adresse et date : plus modifiables dès que la visite est commencée, par personne', async () => {
  const { v } = await newVisit();
  assert.equal((await upd('c1@x.fr', v, { status: 'in_progress' })).result, 'applied');
  assert.equal((await upd('c1@x.fr', v, { location_text: 'trop tard' }, 2)).code, 'locked_status');
  assert.equal((await upd('mgr1@x.fr', v, { location_text: 'trop tard' }, 2)).code, 'locked_status');
  assert.equal((await upd('c1@x.fr', v, { planned_start: '2026-12-01T10:00:00Z' }, 2)).code, 'locked_status');
});

test('date prévue et statut : l\'auteur seul ; un manager ne peut modifier que l\'adresse', async () => {
  const { v } = await newVisit();
  assert.equal((await upd('mgr1@x.fr', v, { planned_start: '2026-12-01T10:00:00Z' })).code, 'forbidden');
  assert.equal((await upd('mgr1@x.fr', v, { status: 'organized' })).code, 'forbidden');
  assert.equal((await upd('mgr1@x.fr', v, { location_text: 'ok', objective: 'pas ok' })).code, 'forbidden', 'un mélange avec un champ réservé est refusé en bloc');
});

test('statut : transitions autorisées seulement (organisée, retour à organiser, pas de retour après « terminée »)', async () => {
  const { v } = await newVisit();
  assert.equal((await upd('c1@x.fr', v, { status: 'organized' })).version, 2);
  assert.equal((await upd('c1@x.fr', v, { status: 'planned' }, 2)).result, 'applied');        // organisation annulée
  assert.equal((await upd('c1@x.fr', v, { status: 'in_progress' }, 3)).result, 'applied');
  assert.equal((await upd('c1@x.fr', v, { status: 'organized' }, 4)).code, 'locked_status');
  assert.equal((await upd('c1@x.fr', v, { status: 'done' }, 4)).result, 'applied');
  assert.equal((await upd('c1@x.fr', v, { status: 'planned' }, 5)).code, 'locked_status');
});

test('historique : chaque modification de date prévue et d\'adresse est tracée (qui, quand, ancienne et nouvelle valeur), lisible par ceux qui voient la visite', async () => {
  await setMode(env.pool, 2);
  const { v } = await newVisit();
  await upd('c1@x.fr', v, { planned_start: '2026-12-01T13:30:00Z' }, 1);
  await upd('mgr1@x.fr', v, { location_text: 'Nouvelle adresse' }, 2);
  await upd('c1@x.fr', v, { location_text: 'Nouvelle adresse' }, 3);           // même valeur : rien à tracer
  const h = (await env.pool.query(`SELECT field, old_value, new_value, changed_by_name FROM visit_history WHERE visit_id = $1 ORDER BY changed_at, seq`, [v])).rows;
  assert.deepEqual(h.map(x => x.field), ['planned_start', 'location_text']);
  assert.equal(new Date(h[0].old_value).toISOString(), '2026-11-26T10:00:00.000Z');
  assert.equal(new Date(h[0].new_value).toISOString(), '2026-12-01T13:30:00.000Z');
  assert.equal(h[0].changed_by_name, 'c1');
  assert.deepEqual([h[1].old_value, h[1].new_value, h[1].changed_by_name], ['12 rue des Lilas', 'Nouvelle adresse', 'mgr1']);

  for (const who of ['c1@x.fr', 'mgr1@x.fr', 'dir@x.fr']) {
    const rows = ((await (await f.login(who)).pullAll()).changes.visit_history ?? []).filter(x => x.visit_id === v);
    assert.equal(rows.length, 2, who);
  }
  for (const who of ['c2@x.fr', 'c3@x.fr', 'mgr2@x.fr']) {
    const rows = ((await (await f.login(who)).pullAll()).changes.visit_history ?? []).filter(x => x.visit_id === v);
    assert.equal(rows.length, 0, `${who} ne voit pas la visite, donc pas son historique`);
  }
  // l'appareil ne peut pas écrire dans l'historique
  const w = await (await f.login('c1@x.fr')).push([op('visit_history', 'create', uuid(), { visit_id: v })]);
  assert.equal(w.body.results[0].code, 'not_implemented');
});

test('API CRM : l\'historique est exposé en lecture', async () => {
  const key = await createServiceKey(env.pool);
  const r = await new Api(env.base).call('GET', '/api/crm/v1/visit-history', undefined, { authorization: `Bearer ${key}` });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length >= 2);
  assert.ok(r.body.items.every((x: any) => x.changed_by_name && x.field));
});

test('compte rendu : validation seulement visite terminée ; elle crée les actions prévues et passe la visite à « validée »', async () => {
  const a = await f.login('c1@x.fr');
  const v = uuid(), r = uuid(), d1 = uuid(), d2 = uuid();
  const draft = [{ id: d1, title: 'Envoyer le devis', due_date: '2026-11-26', origin: 'ai' }, { id: d2, title: 'Rappeler M. Martin', due_date: null, origin: 'manual' }];
  await a.push([op('visit', 'create', v, { company_id: f.f1, status: 'in_progress' }), op('report', 'create', r, { visit_id: v, language: 'fr', summary: 'Résumé', draft_actions: draft })]);
  const actionsOf = async () => (await env.pool.query(`SELECT id, title, origin, owner_id, author_id, status FROM action_item WHERE visit_id = $1 ORDER BY title`, [v])).rows;
  assert.equal((await actionsOf()).length, 0, 'actions prévues seulement : aucune vraie action avant la validation');

  const early = (await a.push([op('report', 'update', r, { status: 'validated', no_action: true }, 1)])).body.results[0];
  assert.equal(early.code, 'locked_status', 'visite pas terminée : validation refusée');
  assert.equal((await env.pool.query(`SELECT status FROM visit_report WHERE id = $1`, [r])).rows[0].status, 'draft');
  assert.equal((await a.push([op('visit', 'update', v, { status: 'done' }, 1)])).body.results[0].result, 'applied');
  assert.equal((await actionsOf()).length, 0, 'terminer la visite ne crée pas d\'action');

  const ok = (await a.push([op('report', 'update', r, { status: 'validated', no_action: true }, 1)])).body.results[0];
  assert.equal(ok.result, 'applied');
  const acts = await actionsOf();
  assert.deepEqual(acts.map(x => [x.id, x.title, x.origin, x.status]), [[d1, 'Envoyer le devis', 'ai', 'todo'], [d2, 'Rappeler M. Martin', 'manual', 'todo']].sort((x, y) => String(x[1]).localeCompare(String(y[1]))));
  assert.ok(acts.every(x => x.owner_id === f.c1 && x.author_id === f.c1));
  assert.equal((await env.pool.query(`SELECT status FROM visit WHERE id = $1`, [v])).rows[0].status, 'validated');
  assert.deepEqual((await env.pool.query(`SELECT draft_actions FROM visit_report WHERE id = $1`, [r])).rows[0].draft_actions, [], 'actions prévues converties');
});

test('compte rendu validé : verrouillé ; seule la remise en brouillon est possible ; elle ramène la visite à « terminée » ; pas de doublon à la nouvelle validation', async () => {
  const a = await f.login('c1@x.fr');
  const d1 = uuid();
  const { visit, report } = await validatedVisit(a, f.f1, [{ id: d1, title: 'Une action' }]);
  const rv = async (payload: Record<string, unknown>, base: number) => (await a.push([op('report', 'update', report, payload, base)])).body.results[0];
  const version = async () => (await env.pool.query(`SELECT version FROM visit_report WHERE id = $1`, [report])).rows[0].version as number;

  for (const payload of [{ summary: 'Modifié' }, { draft_actions: [] }, { status: 'draft', summary: 'Modifié en même temps' }, { next_step: 'x' }]) {
    const r = await rv(payload, await version());
    assert.equal(r.code, 'locked_status', JSON.stringify(payload));
  }
  assert.equal((await env.pool.query(`SELECT summary FROM visit_report WHERE id = $1`, [report])).rows[0].summary, 'Résumé');
  // un autre utilisateur ne peut pas non plus le rouvrir
  assert.equal((await (await f.login('mgr1@x.fr')).push([op('report', 'update', report, { status: 'draft' }, await version())])).body.results[0].code, 'forbidden');

  const reopen = await rv({ status: 'draft' }, await version());
  assert.equal(reopen.result, 'applied');
  const row = (await env.pool.query(`SELECT status, validated_at, validated_by FROM visit_report WHERE id = $1`, [report])).rows[0];
  assert.deepEqual([row.status, row.validated_at, row.validated_by], ['draft', null, null]);
  assert.equal((await env.pool.query(`SELECT status FROM visit WHERE id = $1`, [visit])).rows[0].status, 'done', 'la visite redevient terminée');
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM action_item WHERE visit_id = $1`, [visit])).rows[0].n, 1, 'les actions déjà créées sont conservées');

  // modifiable de nouveau ; nouvelle validation : seules les NOUVELLES actions prévues sont créées
  assert.equal((await rv({ summary: 'Corrigé', draft_actions: [{ id: uuid(), title: 'Nouvelle', due_date: null, origin: 'manual' }] }, await version())).result, 'applied');
  assert.equal((await rv({ status: 'validated', no_action: true }, await version())).result, 'applied');
  assert.deepEqual((await env.pool.query(`SELECT title FROM action_item WHERE visit_id = $1 ORDER BY title`, [visit])).rows.map(x => x.title), ['Nouvelle', 'Une action']);
  assert.equal((await env.pool.query(`SELECT status FROM visit WHERE id = $1`, [visit])).rows[0].status, 'validated');
});

test('notes durant visite : plus modifiables une fois la visite terminée (ajout, modification, suppression) ; notes internes non concernées', async () => {
  const a = await f.login('c1@x.fr');
  const v = uuid(), n = uuid(), inn = uuid();
  await a.push([op('visit', 'create', v, { company_id: f.f1, status: 'in_progress' }), op('note', 'create', n, { visit_id: v, kind: 'text', body: 'Pendant la visite' })]);
  assert.equal((await a.push([op('note', 'update', n, { body: 'Corrigée' })])).body.results[0].result, 'applied', 'visite en cours : modifiable');
  assert.equal((await a.push([op('visit', 'update', v, { status: 'done' }, 1)])).body.results[0].result, 'applied');
  const locked = async (o: Record<string, unknown>) => (await a.push([o])).body.results[0].code;
  assert.equal(await locked(op('note', 'update', n, { body: 'Trop tard' })), 'locked_status');
  assert.equal(await locked(op('note', 'delete', n, {})), 'locked_status');
  assert.equal(await locked(op('note', 'create', uuid(), { visit_id: v, kind: 'text', body: 'Après coup' })), 'locked_status');
  assert.equal((await env.pool.query(`SELECT body, deleted_at FROM visit_note WHERE id = $1`, [n])).rows[0].body, 'Corrigée');
  assert.equal((await a.push([op('internal_note', 'create', inn, { visit_id: v, body: 'Info interne après la visite' })])).body.results[0].result, 'applied', 'note interne : toujours possible');
  // visite annulée : verrouillée aussi
  const v2 = uuid(), n2 = uuid();
  await a.push([op('visit', 'create', v2, { company_id: f.f1, status: 'planned' }), op('note', 'create', n2, { visit_id: v2, kind: 'text', body: 'x' })]);
  await a.push([op('visit', 'update', v2, { status: 'cancelled' }, 1)]);
  assert.equal(await locked(op('note', 'update', n2, { body: 'y' })), 'locked_status');
});

test('actions : créées depuis une visite et seulement une fois le compte rendu validé', async () => {
  const a = await f.login('c1@x.fr');
  const act = (company: string, visitId: string | undefined, title = 'Manuelle') => op('action', 'create', uuid(), { company_id: company, ...(visitId ? { visit_id: visitId } : {}), title, origin: 'manual' });
  const r1 = async (o: Record<string, unknown>) => (await a.push([o])).body.results[0];
  // sans visite : refusé
  assert.equal((await r1(act(f.f1, undefined))).code, 'validation_failed');
  // visite dont le compte rendu n'est pas validé : refusé (draft ou absent)
  const v = uuid(), r = uuid();
  await a.push([op('visit', 'create', v, { company_id: f.f1, status: 'done' }), op('report', 'create', r, { visit_id: v, language: 'fr', summary: 'Résumé' })]);
  assert.equal((await r1(act(f.f1, v))).code, 'locked_status');
  const noReport = uuid(); await a.push([op('visit', 'create', noReport, { company_id: f.f1, status: 'in_progress' })]);
  assert.equal((await r1(act(f.f1, noReport))).code, 'locked_status');
  // compte rendu validé : ajout manuel possible
  assert.equal((await a.push([op('report', 'update', r, { status: 'validated', no_action: true }, 1)])).body.results[0].result, 'applied');
  assert.equal((await r1(act(f.f1, v))).result, 'applied');
  // client qui ne correspond pas à la visite ; autre auteur
  assert.equal((await r1(act(uuid(), v))).code, 'validation_failed');
  assert.equal((await (await f.login('mgr1@x.fr')).push([act(f.f1, v)])).body.results[0].code, 'forbidden');
  // une fois remis en brouillon, la création directe est de nouveau refusée
  assert.equal((await a.push([op('report', 'update', r, { status: 'draft' }, 2)])).body.results[0].result, 'applied');
  assert.equal((await r1(act(f.f1, v))).code, 'locked_status');
});

test('suppression : auteur commercial ou directeur ; refus manager et autre commercial ; refus tant que des actions sont à faire ; visite figée ensuite', async () => {
  await setMode(env.pool, 1);
  // l'auteur supprime sa visite
  const { a, v } = await newVisit();
  assert.equal((await upd('mgr1@x.fr', v, { status: 'deleted' })).code, 'forbidden');
  assert.equal((await upd('c3@x.fr', v, { status: 'deleted' })).code, 'forbidden');
  const del = await upd('c1@x.fr', v, { status: 'deleted' });
  assert.equal(del.result, 'applied');
  // la visite supprimée reste lisible (synchronisée) et ne bouge plus
  assert.equal((await upd('c1@x.fr', v, { status: 'planned' }, del.version)).code, 'locked_status');
  assert.equal((await upd('c1@x.fr', v, { location_text: 'x' }, del.version)).code, 'locked_status');
  const pulled = (await a.pullAll()).changes.visits.find((x: any) => x.id === v);
  assert.equal(pulled.status, 'deleted');
  // un directeur peut supprimer la visite d'un autre ; il ne peut rien modifier d'autre
  const n = await newVisit();
  assert.equal((await upd('dir@x.fr', n.v, { status: 'in_progress', started_at: '2026-11-26T10:00:00Z' })).code, 'forbidden');
  assert.equal((await upd('dir@x.fr', n.v, { status: 'deleted' })).result, 'applied');
  // visite validée avec une action à faire : suppression refusée ; une fois l'action terminée, acceptée
  const vv = await validatedVisit(await f.login('c1@x.fr'), f.f1, [{ id: uuid(), title: 'Rappeler' }]);
  const todo = (await env.pool.query(`SELECT id, version FROM action_item WHERE visit_id = $1`, [vv.visit])).rows[0];
  const vVersion = (await env.pool.query(`SELECT version FROM visit WHERE id = $1`, [vv.visit])).rows[0].version;
  assert.equal((await upd('c1@x.fr', vv.visit, { status: 'deleted' }, vVersion)).code, 'locked_status');
  const c1 = await f.login('c1@x.fr');
  assert.equal((await c1.push([op('action', 'update', todo.id, { status: 'done' }, todo.version)])).body.results[0].result, 'applied');
  assert.equal((await upd('c1@x.fr', vv.visit, { status: 'deleted' }, vVersion)).result, 'applied');
  // plus de notes internes, d'actions ni de compte rendu sur une visite supprimée
  const bad = (await c1.push([op('internal_note', 'create', uuid(), { visit_id: vv.visit, body: 'x' }), op('action', 'create', uuid(), { company_id: f.f1, visit_id: vv.visit, title: 'x', origin: 'manual' })])).body.results;
  assert.deepEqual(bad.map((x: any) => x.code), ['locked_status', 'locked_status']);
});

const doneVisit = async (extra: Record<string, unknown> = {}) => {
  const { a, v } = await newVisit('c1@x.fr', { status: 'done', ...extra });
  const r = uuid();
  assert.equal((await a.push([op('report', 'create', r, { visit_id: v, language: 'fr', summary: 'Résumé' })])).body.results[0].result, 'applied');
  return { a, v, r };
};
const histOf = async (v: string) => (await env.pool.query(`SELECT field, changed_by_name FROM visit_history WHERE visit_id = $1 ORDER BY changed_at, id`, [v])).rows.map(x => x.field);

test('validation du compte rendu : sans action, « aucune action à prévoir » est exigé ; avec une action prévue ou déjà créée, non', async () => {
  const { a, v, r } = await doneVisit();
  const bad = (await a.push([op('report', 'update', r, { status: 'validated' }, 1)])).body.results[0];
  assert.equal(bad.code, 'validation_failed'); assert.match(bad.message, /aucune action à prévoir/);
  assert.equal((await a.push([op('report', 'update', r, { status: 'validated', no_action: true }, 1)])).body.results[0].result, 'applied');
  // avec une action prévue : pas de case à cocher
  const w = await doneVisit();
  assert.equal((await w.a.push([op('report', 'update', w.r, { status: 'validated', draft_actions: [{ id: uuid(), title: 'Rappeler', due_date: null, origin: 'manual' }] }, 1)])).body.results[0].result, 'applied');
  // remise en brouillon puis nouvelle validation : l'action existe déjà, la case n'est plus exigée
  assert.equal((await w.a.push([op('report', 'update', w.r, { status: 'draft' }, 2)])).body.results[0].result, 'applied');
  assert.equal((await w.a.push([op('report', 'update', w.r, { status: 'validated' }, 3)])).body.results[0].result, 'applied');
  void v;
});

test('historique : validation, remise en brouillon et suppression de la visite sont tracées', async () => {
  const { a, v, r } = await doneVisit();
  await a.push([op('report', 'update', r, { status: 'validated', no_action: true }, 1)]);
  await a.push([op('report', 'update', r, { status: 'draft' }, 2)]);
  await a.push([op('report', 'update', r, { status: 'validated' }, 3)]);
  const ver = (await env.pool.query(`SELECT version FROM visit WHERE id = $1`, [v])).rows[0].version;
  assert.equal((await upd('c1@x.fr', v, { status: 'deleted' }, ver)).result, 'applied');
  assert.deepEqual(await histOf(v), ['report_validated', 'report_reopened', 'report_validated', 'visit_deleted']);
  const pulled = (await a.pullAll()).changes.visit_history.filter((h: any) => h.visit_id === v);
  assert.equal(pulled.length, 4); assert.equal(pulled[0].changed_by_name, 'c1');
});

test('compte rendu transmis au client : plus de remise en brouillon', async () => {
  const { a, v, r } = await doneVisit();
  await a.push([op('report', 'update', r, { status: 'validated', no_action: true }, 1)]);
  await env.pool.query(`UPDATE visit_report SET sent_to_client_at = now() WHERE id = $1`, [r]);
  const res = (await a.push([op('report', 'update', r, { status: 'draft' }, 2)])).body.results[0];
  assert.equal(res.code, 'locked_status'); assert.match(res.message, /transmis au client/);
  assert.equal((await env.pool.query(`SELECT status FROM visit WHERE id = $1`, [v])).rows[0].status, 'validated');
});

test('notes internes : ajout possible après validation du compte rendu, modification et suppression refusées', async () => {
  const { a, v, r } = await doneVisit();
  const n = uuid();
  assert.equal((await a.push([op('internal_note', 'create', n, { visit_id: v, body: 'avant' })])).body.results[0].result, 'applied');
  assert.equal((await a.push([op('internal_note', 'update', n, { body: 'corrigée' })])).body.results[0].result, 'applied', 'visite terminée : encore modifiable');
  await a.push([op('report', 'update', r, { status: 'validated', no_action: true }, 1)]);
  assert.equal((await a.push([op('internal_note', 'create', uuid(), { visit_id: v, body: 'après' })])).body.results[0].result, 'applied');
  assert.equal((await a.push([op('internal_note', 'update', n, { body: 'x' })])).body.results[0].code, 'locked_status');
  assert.equal((await a.push([op('internal_note', 'delete', n, {})])).body.results[0].code, 'locked_status');
});

test('échéance d\'action antérieure à la visite : refusée (action et action prévue) ; tolérance d\'un jour', async () => {
  const { a, v, r } = await doneVisit({ started_at: '2026-11-20T09:00:00Z' });
  assert.equal((await a.push([op('report', 'update', r, { draft_actions: [{ id: uuid(), title: 'x', due_date: '2026-11-10', origin: 'manual' }] }, 1)])).body.results[0].code, 'validation_failed');
  assert.equal((await a.push([op('report', 'update', r, { draft_actions: [{ id: uuid(), title: 'x', due_date: '2026-11-19', origin: 'manual' }] }, 1)])).body.results[0].result, 'applied', 'la veille : toléré');
  assert.equal((await a.push([op('report', 'update', r, { status: 'validated' }, 2)])).body.results[0].result, 'applied');
  const act = (due: string | null) => op('action', 'create', uuid(), { company_id: f.f1, visit_id: v, title: 'Autre', due_date: due, origin: 'manual' });
  assert.equal((await a.push([act('2026-11-01')])).body.results[0].code, 'validation_failed');
  assert.equal((await a.push([act('2026-12-01')])).body.results[0].result, 'applied');
  const id = (await env.pool.query(`SELECT id, version FROM action_item WHERE visit_id = $1 AND title = 'Autre'`, [v])).rows[0];
  assert.equal((await a.push([op('action', 'update', id.id, { due_date: '2026-11-02' }, id.version)])).body.results[0].code, 'validation_failed');
});

test('annulation : refusée tant que des actions restent à faire', async () => {
  const { a, v } = await newVisit('c1@x.fr', { status: 'in_progress' });
  await insertAction(env.pool, { company: f.f1, visit: v, author: (await env.pool.query(`SELECT author_id FROM visit WHERE id = $1`, [v])).rows[0].author_id });
  assert.equal((await upd('c1@x.fr', v, { status: 'cancelled' })).code, 'locked_status');
  void a;
});

test('règles partagées : compte rendu en retard, étape « terminée », aucune action, échéance, notes internes', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  assert.equal(isReportLate({ status: 'done', ended_at: '2026-11-18T12:00:00Z' }, now), true);
  assert.equal(isReportLate({ status: 'done', ended_at: '2026-11-20T12:00:00Z' }, now), false);
  assert.equal(isReportLate({ status: 'validated', ended_at: '2026-01-01T00:00:00Z' }, now), false);
  assert.equal(visitStage('validated', 0), 'closed'); assert.equal(visitStage('validated', 2), 'validated'); assert.equal(visitStage('done', 0), 'done');
  assert.equal(needsNoActionAck(0, 0, false), true); assert.equal(needsNoActionAck(0, 0, true), false); assert.equal(needsNoActionAck(1, 0, false), false); assert.equal(needsNoActionAck(0, 2, false), false);
  assert.equal(isDueBeforeVisit('2026-11-10', { started_at: '2026-11-20T09:00:00Z' }), true);
  assert.equal(isDueBeforeVisit('2026-11-10', {}), false); assert.equal(isDueBeforeVisit(null, { started_at: '2026-11-20T09:00:00Z' }), false);
  assert.equal(canEditInternalNote('done'), true); assert.equal(canEditInternalNote('validated'), false);
});

test('migration : une base existante reçoit le statut « organisée » et l\'historique, sans perdre de données', async () => {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres' });
  await admin.connect();
  const name = `vc_mig_${uuid().replace(/-/g, '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres'); url.pathname = `/${name}`;
  const { createPool } = await import('../src/db.js');
  const pool = createPool(url.toString());
  try {
    assert.deepEqual(await migrate(pool), [], 'base vide : schéma complet, migrations marquées appliquées');
    // on fait revenir la base à l'état d'avant la migration 001, avec une visite existante
    await pool.query(`ALTER TABLE visit_report DROP COLUMN draft_actions; DROP FUNCTION can_read_internal_note(uuid, uuid); DROP TABLE internal_note; DROP VIEW crm_visit_history; DROP TABLE visit_history; DELETE FROM schema_migrations;
      ALTER TABLE visit DROP CONSTRAINT visit_status_check;
      ALTER TABLE visit ADD CONSTRAINT visit_status_check CHECK (status IN ('planned','in_progress','done','cancelled'))`);
    const u = (await pool.query(`INSERT INTO app_user(email, display_name, role, password_hash) VALUES ('m@x.fr','M','commercial','h') RETURNING id`)).rows[0].id;
    const co = (await pool.query(`INSERT INTO company(crm_id, name) VALUES ('K','K') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO visit(id, company_id, author_id, location_text) VALUES ($1,$2,$3,'ancienne')`, [uuid(), co, u]);
    await assert.rejects(pool.query(`UPDATE visit SET status = 'organized'`), /visit_status_check/);

    assert.deepEqual(await migrate(pool), ['001_visite_organisee_et_historique.sql', '002_visite_validee.sql', '003_notes_internes.sql', '004_actions_depuis_compte_rendu.sql', '005_visite_supprimee.sql', '006_regles_compte_rendu.sql']);
    await pool.query(`UPDATE visit SET status = 'organized'`);                    // maintenant accepté
    assert.equal((await pool.query(`SELECT count(*)::int n FROM visit WHERE location_text = 'ancienne'`)).rows[0].n, 1, 'données conservées');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM visit_history`)).rows[0].n, 0);
    assert.deepEqual(await migrate(pool), [], 'rejouer ne fait rien');
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); }
});
