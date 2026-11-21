import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, op, uuid, setMode, createServiceKey, Api, type TestEnv, type Fixture } from './helpers.js';
import { migrate } from '../src/migrate.js';
import pg from 'pg';

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

test('visite terminée + compte rendu validé => visite « validée », dans les deux ordres ; statut jamais attribué à la main', async () => {
  const a = await f.login('c1@x.fr');
  // ordre 1 : terminer d'abord, valider le compte rendu ensuite
  const v1 = uuid(), r1 = uuid();
  await a.push([op('visit', 'create', v1, { company_id: f.f1, status: 'planned' }), op('report', 'create', r1, { visit_id: v1, language: 'fr', summary: 'Résumé' })]);
  await a.push([op('visit', 'update', v1, { status: 'in_progress' }, 1)]);
  await a.push([op('visit', 'update', v1, { status: 'done' }, 2)]);
  assert.equal((await env.pool.query(`SELECT status FROM visit WHERE id = $1`, [v1])).rows[0].status, 'done', 'compte rendu en brouillon : reste terminée');
  const val = await a.push([op('report', 'update', r1, { status: 'validated' }, 1)]);
  assert.equal(val.body.results[0].result, 'applied');
  assert.equal((await env.pool.query(`SELECT status FROM visit WHERE id = $1`, [v1])).rows[0].status, 'validated');
  // ordre 2 : compte rendu validé pendant la visite, puis visite terminée
  const v2 = uuid(), r2 = uuid();
  await a.push([op('visit', 'create', v2, { company_id: f.f1, status: 'in_progress' }), op('report', 'create', r2, { visit_id: v2, language: 'fr', summary: 'Résumé', status: 'validated' })]);
  assert.equal((await env.pool.query(`SELECT status FROM visit WHERE id = $1`, [v2])).rows[0].status, 'in_progress', 'pas encore terminée');
  await a.push([op('visit', 'update', v2, { status: 'done' }, 1)]);
  assert.equal((await env.pool.query(`SELECT status FROM visit WHERE id = $1`, [v2])).rows[0].status, 'validated');
  // l'appareil reçoit le statut ; il ne peut pas l'imposer ; une visite validée n'est plus modifiable
  const got = (await a.pullAll()).changes.visits!.find(x => x.id === v1)!;
  assert.equal(got.status, 'validated');
  const manual = await a.push([op('visit', 'update', v2, { status: 'validated' }, 3)]);
  assert.equal(manual.body.results[0].code, 'locked_status');
  const created = await a.push([op('visit', 'create', uuid(), { company_id: f.f1, status: 'validated' })]);
  assert.equal(created.body.results[0].code, 'validation_failed');
  assert.equal((await upd('c1@x.fr', v1, { location_text: 'trop tard' }, got.version)).code, 'locked_status');
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
    await pool.query(`DROP VIEW crm_visit_history; DROP TABLE visit_history; DELETE FROM schema_migrations;
      ALTER TABLE visit DROP CONSTRAINT visit_status_check;
      ALTER TABLE visit ADD CONSTRAINT visit_status_check CHECK (status IN ('planned','in_progress','done','cancelled'))`);
    const u = (await pool.query(`INSERT INTO app_user(email, display_name, role, password_hash) VALUES ('m@x.fr','M','commercial','h') RETURNING id`)).rows[0].id;
    const co = (await pool.query(`INSERT INTO company(crm_id, name) VALUES ('K','K') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO visit(id, company_id, author_id, location_text) VALUES ($1,$2,$3,'ancienne')`, [uuid(), co, u]);
    await assert.rejects(pool.query(`UPDATE visit SET status = 'organized'`), /visit_status_check/);

    assert.deepEqual(await migrate(pool), ['001_visite_organisee_et_historique.sql', '002_visite_validee.sql']);
    await pool.query(`UPDATE visit SET status = 'organized'`);                    // maintenant accepté
    assert.equal((await pool.query(`SELECT count(*)::int n FROM visit WHERE location_text = 'ancienne'`)).rows[0].n, 1, 'données conservées');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM visit_history`)).rows[0].n, 0);
    assert.deepEqual(await migrate(pool), [], 'rejouer ne fait rien');
  } finally { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); }
});
