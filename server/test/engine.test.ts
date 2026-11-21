import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine, MemoryStore, SqliteStore, ApiClient, NetworkError, type Transport, type Store } from '@visites/sync-core';
import { nodeSqlDb } from './helpers-sqlite.js';
import { setup, fixture, uuid, setMode, type TestEnv, type Fixture } from './helpers.js';

let env: TestEnv; let f: Fixture;
before(async () => { env = await setup(); f = await fixture(env); });
after(async () => { await env.close(); });

/** Un appareil complet : stockage local, moteur de synchro, client HTTP réel. */
async function device(kind: 'mémoire' | 'SQLite', email: string, userId: string, transportWrap?: (t: Transport) => Transport) {
  const client = new ApiClient(env.base + '/api/mobile/v1', '1.0.0', undefined);
  await client.login(email, 'mot-de-passe-de-test-12', 'ios');
  const store: Store = kind === 'SQLite' ? await SqliteStore.open(nodeSqlDb()) : new MemoryStore();
  const engine = new SyncEngine(store, transportWrap ? transportWrap(client) : client, { newId: uuid, userId });
  return { store, engine, client };
}

for (const kind of ['mémoire', 'SQLite'] as const) {

test(`[${kind}] moteur : saisie hors-ligne, file d\'opérations, puis synchro vers le serveur`, async () => {
  const d = await device(kind, 'c1@x.fr', f.c1);
  await d.engine.sync();                                          // reçoit les clients
  const company = (await d.store.list('companies'))[0]!;
  assert.equal(company.name, 'Dupont SA');

  const v = await d.engine.create('visit', { company_id: company.id, status: 'planned', objective: 'Suivi' });
  const a = await d.engine.create('action', { company_id: company.id, visit_id: v, title: 'Envoyer le devis', due_date: '2026-11-26' });
  assert.equal(await d.store.pendingCount(), 2);                   // rien n'est parti : saisie locale seulement
  assert.equal((await d.store.get('actions', a))!.status, 'todo'); // visible tout de suite dans l'appli

  const rep = await d.engine.sync();
  assert.equal(rep.rejected.length, 0);
  assert.equal(await d.store.pendingCount(), 0);
  const srv = (await env.pool.query(`SELECT title FROM action_item WHERE id = $1`, [a])).rows[0];
  assert.equal(srv.title, 'Envoyer le devis');
});

test(`[${kind}] moteur : plusieurs modifications hors-ligne de la même entité sont fusionnées en une opération sans conflit avec soi-même`, async () => {
  const d = await device(kind, 'c1@x.fr', f.c1);
  await d.engine.sync();
  const company = (await d.store.list('companies'))[0]!;
  const act = await d.engine.create('action', { company_id: company.id, title: 'Appeler' });
  await d.engine.sync();                                           // l'action existe côté serveur (version 1)
  await d.engine.update('action', act, { title: 'Appeler M. Martin' });
  await d.engine.update('action', act, { due_date: '2026-11-27' });
  await d.engine.update('action', act, { status: 'done' });
  assert.equal(await d.store.pendingCount(), 1);
  const rep = await d.engine.sync();
  assert.equal(rep.conflicts.length, 0);
  const srv = (await env.pool.query(`SELECT title, due_date, status, version FROM action_item WHERE id = $1`, [act])).rows[0];
  assert.deepEqual({ ...srv }, { title: 'Appeler M. Martin', due_date: '2026-11-27', status: 'done', version: 2 });
});

test(`[${kind}] moteur : coupure réseau : la file est conservée et partira à la reconnexion`, async () => {
  let online = false;
  const d = await device(kind, 'c1@x.fr', f.c1, t => ({
    push: ops => online ? t.push(ops) : Promise.reject(new NetworkError()),
    pull: (c, l) => online ? t.pull(c, l) : Promise.reject(new NetworkError()),
  }));
  online = true; await d.engine.sync(); online = false;
  const company = (await d.store.list('companies'))[0]!;
  const v = await d.engine.create('visit', { company_id: company.id, status: 'planned' });
  const off = await d.engine.sync();
  assert.equal(off.offline, true);
  assert.equal(await d.store.pendingCount(), 1);
  online = true;
  const on = await d.engine.sync();
  assert.equal(on.offline, false);
  assert.equal(await d.store.pendingCount(), 0);
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM visit WHERE id = $1`, [v])).rows[0].n, 1);
});

test(`[${kind}] moteur : conflit entre deux appareils d\'un même utilisateur : le serveur l\'emporte et l\'appareil converge`, async () => {
  const a = await device(kind, 'c1@x.fr', f.c1), b = await device(kind, 'c1@x.fr', f.c1);
  await a.engine.sync(); await b.engine.sync();
  const company = (await a.store.list('companies'))[0]!;
  const v = await a.engine.create('visit', { company_id: company.id, status: 'planned', location_text: 'Lyon' });
  await a.engine.sync(); await b.engine.sync();                    // B reçoit la visite
  await a.engine.update('visit', v, { location_text: 'Lyon 3e' });
  await b.engine.update('visit', v, { location_text: 'Villeurbanne' });
  await a.engine.sync();
  const rb = await b.engine.sync();
  assert.equal(rb.conflicts.length, 1);
  assert.equal((await b.store.get('visits', v))!.location_text, 'Lyon 3e');   // B a reçu la valeur du serveur
});

test(`[${kind}] moteur : une opération refusée retire la création locale`, async () => {
  const d = await device(kind, 'c2@x.fr', f.c2);                         // c2 n'a aucun client
  const v = await d.engine.create('visit', { company_id: f.f1, status: 'planned' });
  const rep = await d.engine.sync();
  assert.equal(rep.rejected.length, 1);
  assert.equal(await d.store.get('visits', v), undefined);
});

test(`[${kind}] moteur : retrait d\'accès côté serveur : l\'appareil supprime la donnée et ses dépendances`, async () => {
  await setMode(env.pool, 1);
  const c3 = await device(kind, 'c3@x.fr', f.c3);
  const c1 = await device(kind, 'c1@x.fr', f.c1);
  await c1.engine.sync();
  const company = (await c1.store.list('companies'))[0]!;
  const v = await c1.engine.create('visit', { company_id: company.id, status: 'done' });
  await c1.engine.create('note', { visit_id: v, kind: 'text', body: 'Compte rendu' });
  await c1.engine.sync();
  await c3.engine.sync();
  assert.ok(await c3.store.get('visits', v));
  assert.ok((await c3.store.list('notes')).length > 0);

  const admin = await device(kind, 'admin@x.fr', f.admin);
  const adminUrl = env.base + '/api/admin/v1/companies/' + f.f1 + '/assignments';
  const res = await fetch(adminUrl, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${(admin.client as any).tokens.access_token}` }, body: JSON.stringify({ user_ids: [f.c1] }) });
  assert.equal(res.status, 200);

  const rep = await c3.engine.sync();
  assert.ok(rep.revoked > 0);
  assert.equal(await c3.store.get('visits', v), undefined);
  assert.equal((await c3.store.list('notes')).filter(n => n.visit_id === v).length, 0);
  assert.equal(await c3.store.get('companies', f.f1), undefined);
  await fetch(adminUrl, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${(admin.client as any).tokens.access_token}` }, body: JSON.stringify({ user_ids: [f.c1, f.c3] }) });   // remise en état pour le test suivant
  await setMode(env.pool, 2);
});

test(`[${kind}] moteur : notes modifiées puis supprimées ; note interne vue par la hiérarchie, retirée à sa suppression`, async () => {
  const c1 = await device(kind, 'c1@x.fr', f.c1), mgr = await device(kind, 'mgr1@x.fr', f.mgr1);
  await c1.engine.sync();
  const company = (await c1.store.list('companies'))[0]!;
  const v = await c1.engine.create('visit', { company_id: company.id, status: 'in_progress' });
  const n = await c1.engine.create('note', { visit_id: v, kind: 'text', body: 'Première version' });
  const inn = await c1.engine.create('internal_note', { visit_id: v, body: 'Info interne' });
  await c1.engine.update('note', n, { body: 'Deuxième version' });            // fusionnée dans l'opération de création en attente
  await c1.engine.update('internal_note', inn, { body: 'Info interne corrigée' });
  assert.equal(await c1.store.pendingCount(), 3, 'visite, note et note interne : une opération chacune');
  await c1.engine.sync(); await mgr.engine.sync();
  assert.equal((await mgr.store.get('notes', n))!.body, 'Deuxième version');
  assert.equal((await mgr.store.get('internal_notes', inn))!.body, 'Info interne corrigée', 'la hiérarchie reçoit la note interne');
  assert.equal((await mgr.store.get('internal_notes', inn))!.author_name, 'c1');
  // modification d'une note déjà envoyée, puis suppression avec propagation
  await c1.engine.update('note', n, { body: 'Troisième version' });
  await c1.engine.sync(); await mgr.engine.sync();
  assert.equal((await mgr.store.get('notes', n))!.body, 'Troisième version');
  await c1.engine.remove('note', n); await c1.engine.remove('internal_note', inn);
  assert.equal(await c1.store.get('notes', n), undefined, 'disparaît tout de suite chez l\'auteur');
  await c1.engine.sync(); await mgr.engine.sync();
  assert.equal(await mgr.store.get('notes', n), undefined, 'suppression reçue par la hiérarchie');
  assert.equal(await mgr.store.get('internal_notes', inn), undefined);
  // une note créée puis supprimée avant tout envoi ne part jamais
  const tmp = await c1.engine.create('note', { visit_id: v, kind: 'text', body: 'éphémère' });
  const before = await c1.store.pendingCount();
  await c1.engine.remove('note', tmp);
  assert.equal(await c1.store.pendingCount(), before - 1);
});

}
