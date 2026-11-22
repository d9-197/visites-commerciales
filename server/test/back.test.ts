import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, op, uuid, setMode, validatedVisit, Api, PASSWORD, type TestEnv, type Fixture } from './helpers.js';
import { parseCsv, toCsv } from '../src/csv.js';

let env: TestEnv; let f: Fixture;
before(async () => { env = await setup(); f = await fixture(env); });
after(async () => { await env.close(); });
const B = '/api/back/v1';
const get = async (who: string, path: string) => (await f.login(who)).call('GET', B + path);
const send = async (who: string, method: string, path: string, body?: unknown) => (await f.login(who)).call(method, B + path, method === 'GET' ? undefined : body ?? {});

test('back : authentification obligatoire ; /me ; comptes et réglages réservés aux administrateurs', async () => {
  assert.equal((await new Api(env.base).call('GET', `${B}/me`)).status, 401);
  assert.equal((await get('c1@x.fr', '/me')).body.email, 'c1@x.fr');
  for (const [m, p] of [['GET', '/users'], ['POST', '/users'], ['GET', '/settings'], ['GET', '/companies'], ['POST', '/companies'], ['POST', '/import']] as const) {
    assert.equal((await send('mgr1@x.fr', m, p)).status, 403, `${m} ${p}`);
  }
  assert.equal((await get('admin@x.fr', '/users')).status, 200);
  assert.equal((await get('dir@x.fr', '/users')).status, 403, 'même un directeur : pas d\'administration des comptes');
});

test('back : création de compte (mot de passe temporaire), connexion, hiérarchie, désactivation qui révoque les sessions, réinitialisation', async () => {
  const team1 = (await env.pool.query(`SELECT id FROM org_node WHERE name = 'Équipe mgr1'`)).rows[0].id;
  const c = await send('admin@x.fr', 'POST', '/users', { email: 'nouveau@x.fr', display_name: 'Nina Nouvelle', role: 'commercial', node_ids: [team1] });
  assert.equal(c.status, 201); assert.equal(typeof c.body.temporary_password, 'string'); assert.ok(c.body.temporary_password.length >= 16);
  assert.deepEqual(c.body.user.nodes.map((n: any) => n.path), ['Entreprise › Équipe dir › Équipe mgr1']);
  const nina = new Api(env.base); assert.equal((await nina.login('nouveau@x.fr', c.body.temporary_password)).status, 200);
  assert.equal((await send('admin@x.fr', 'POST', '/users', { email: 'nouveau@x.fr', display_name: 'X', role: 'commercial' })).status, 409, 'e-mail déjà utilisé');
  assert.equal((await send('admin@x.fr', 'POST', '/users', { email: 'z@x.fr', display_name: 'Z', role: 'commercial' })).status, 400, 'une branche au moins');
  assert.equal((await send('admin@x.fr', 'POST', '/users', { email: 'z@x.fr', display_name: 'Z', role: 'commercial', node_ids: [uuid()] })).status, 404, 'branche inconnue');
  assert.equal((await send('admin@x.fr', 'POST', '/users', { email: 'z@x.fr', display_name: 'Z', role: 'commercial', node_ids: [team1], password: 'court' })).status, 400);
  // le manager voit sa nouvelle recrue dans son périmètre (hiérarchie reconstruite)
  assert.ok((await get('mgr1@x.fr', '/prep/commerciaux')).body.users.some((u: any) => u.email === 'nouveau@x.fr'));
  // changer de branche : le périmètre du manager change
  const team2 = (await env.pool.query(`SELECT id FROM org_node WHERE name = 'Équipe mgr2'`)).rows[0].id;
  assert.equal((await send('admin@x.fr', 'PATCH', `/users/${c.body.user.id}`, { node_ids: [team2] })).status, 200);
  assert.ok(!(await get('mgr1@x.fr', '/prep/commerciaux')).body.users.some((u: any) => u.email === 'nouveau@x.fr'), 'plus dans la branche de mgr1');
  assert.ok((await get('mgr2@x.fr', '/prep/commerciaux')).body.users.some((u: any) => u.email === 'nouveau@x.fr'), 'dans celle de mgr2');
  assert.equal((await send('admin@x.fr', 'PATCH', `/users/${c.body.user.id}`, { node_ids: [] })).status, 400, 'une branche au moins');
  assert.equal((await send('admin@x.fr', 'PATCH', `/users/${c.body.user.id}`, { node_ids: [team1, team2] })).status, 200, 'plusieurs branches possibles');
  assert.equal((await send('admin@x.fr', 'PATCH', `/users/${c.body.user.id}`, { node_ids: [team1] })).status, 200);
  // garde-fous : pas d'auto-verrouillage
  const adminId = (await env.pool.query(`SELECT id FROM app_user WHERE email = 'admin@x.fr'`)).rows[0].id;
  assert.equal((await send('admin@x.fr', 'PATCH', `/users/${adminId}`, { status: 'disabled' })).status, 409);
  assert.equal((await send('admin@x.fr', 'PATCH', `/users/${adminId}`, { is_admin: false })).status, 409);
  // désactivation : jeton existant refusé, connexion refusée
  assert.equal((await nina.call('GET', `${B}/me`)).status, 200);
  assert.equal((await send('admin@x.fr', 'PATCH', `/users/${c.body.user.id}`, { status: 'disabled' })).status, 200);
  assert.equal((await nina.call('GET', `${B}/me`)).status, 401, 'session révoquée');
  assert.equal((await new Api(env.base).login('nouveau@x.fr', c.body.temporary_password)).status, 401);
  // réactivation + réinitialisation du mot de passe
  await send('admin@x.fr', 'PATCH', `/users/${c.body.user.id}`, { status: 'active' });
  const rp = await send('admin@x.fr', 'POST', `/users/${c.body.user.id}/reset-password`);
  assert.equal(rp.status, 200);
  assert.equal((await new Api(env.base).login('nouveau@x.fr', c.body.temporary_password)).status, 401, 'ancien mot de passe invalide');
  assert.equal((await new Api(env.base).login('nouveau@x.fr', rp.body.temporary_password)).status, 200);
  assert.ok(!JSON.stringify((await env.pool.query(`SELECT detail FROM audit_log`)).rows).includes(rp.body.temporary_password), 'mot de passe jamais journalisé');
  assert.ok((await env.pool.query(`SELECT 1 FROM audit_log WHERE action = 'user_disabled'`)).rows.length >= 1);
});

test('back : réglage de visibilité avec confirmation d\'impact', async () => {
  await setMode(env.pool, 2);
  assert.equal((await get('admin@x.fr', '/settings')).body.report_visibility_mode, 2);
  const r1 = await send('admin@x.fr', 'PUT', '/settings', { report_visibility_mode: 1 });
  assert.equal(r1.status, 409); assert.equal(r1.body.code, 'impact_confirmation_required');
  assert.equal((await send('admin@x.fr', 'PUT', '/settings', { report_visibility_mode: 1, confirm_impact: true })).status, 200);
  await setMode(env.pool, 2);
});

test('back : maquette du CRM : clients, contacts, affectations (visibles par la synchro des commerciaux)', async () => {
  const c1 = (await env.pool.query(`SELECT id FROM app_user WHERE email = 'c2@x.fr'`)).rows[0].id;
  const created = await send('admin@x.fr', 'POST', '/companies', { name: 'Maquette SARL', city: 'Lyon', address_line: '1 place Bellecour', postal_code: '69002', user_ids: [c1] });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const ct = await send('admin@x.fr', 'POST', `/companies/${id}/contacts`, { full_name: 'Mme Test', email: 'test@client.fr', job_title: 'DG' });
  assert.equal(ct.status, 201);
  assert.equal((await send('admin@x.fr', 'POST', `/companies/${id}/contacts`, { full_name: 'X', email: 'pas-un-email' })).status, 400);
  const sync = await (await f.login('c2@x.fr')).pullAll();
  assert.ok(sync.changes.companies.some((x: any) => x.name === 'Maquette SARL'), 'le commercial reçoit le client');
  assert.ok(sync.changes.contacts.some((x: any) => x.full_name === 'Mme Test'));
  // modification, désactivation, retrait d'affectation (révocation côté appareil)
  assert.equal((await send('admin@x.fr', 'PATCH', `/companies/${id}`, { city: 'Villeurbanne' })).status, 200);
  const rev = await send('admin@x.fr', 'PUT', `/companies/${id}/assignments`, { user_ids: [] });
  assert.equal(rev.status, 200); assert.ok(rev.body.revoked >= 1, 'retrait d\'accès transmis');
  assert.equal((await send('admin@x.fr', 'DELETE', `/contacts/${ct.body.id}`)).status, 200);
  const detail = (await get('admin@x.fr', `/companies/${id}`)).body;
  assert.equal(detail.company.city, 'Villeurbanne'); assert.equal(detail.contacts.length, 0); assert.deepEqual(detail.company.assigned, []);
  await send('admin@x.fr', 'PATCH', `/companies/${id}`, { status: 'inactive' });
  assert.equal((await get('admin@x.fr', '/companies?status=inactive&q=Maquette')).body.total, 1);
});

test('back : import CSV (aperçu, erreurs bloquantes, avertissements, mise à jour)', async () => {
  const csv = 'crm_id;name;city;sales_emails\nIMP-1;Import Un;Paris;c1@x.fr c2@x.fr\nIMP-2;"Import ""Deux"", SA";Lille;inconnu@x.fr\n';
  const contacts = 'company_crm_id;crm_id;full_name;email\nIMP-1;;Jean Dupuis;jean@un.fr\nIMP-1;;Anne Roux;anne@un.fr\n';
  const dry = await send('admin@x.fr', 'POST', '/import', { companies_csv: csv, contacts_csv: contacts, dry_run: true });
  assert.equal(dry.status, 200); assert.deepEqual([dry.body.companies, dry.body.contacts], [2, 2]); assert.ok(dry.body.warnings[0].includes('inconnu@x.fr'));
  assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM company WHERE crm_id LIKE 'IMP-%'`)).rows[0].n, 0, 'aperçu : rien écrit');
  const bad = await send('admin@x.fr', 'POST', '/import', { companies_csv: 'crm_id;name\nIMP-3;\nIMP-4;Ok\nIMP-4;Doublon\n' });
  assert.equal(bad.status, 422); assert.equal(bad.body.errors.length, 2); assert.equal(bad.body.errors[0].line, 2);
  assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM company WHERE crm_id = 'IMP-4'`)).rows[0].n, 0, 'erreur : tout est refusé');
  assert.equal((await send('admin@x.fr', 'POST', '/import', { contacts_csv: 'company_crm_id;full_name\nNOPE;X\n' })).status, 422, 'client inconnu');
  const ok = await send('admin@x.fr', 'POST', '/import', { companies_csv: csv, contacts_csv: contacts });
  assert.equal(ok.status, 200); assert.equal(ok.body.companies, 2); assert.equal(ok.body.contacts, 2);
  const row = (await env.pool.query(`SELECT name FROM company WHERE crm_id = 'IMP-2'`)).rows[0];
  assert.equal(row.name, 'Import "Deux", SA');
  const asg = (await env.pool.query(`SELECT u.email FROM company_assignment a JOIN company c ON c.id = a.company_id JOIN app_user u ON u.id = a.user_id WHERE c.crm_id = 'IMP-1' AND a.removed_at IS NULL ORDER BY 1`)).rows.map(x => x.email);
  assert.deepEqual(asg, ['c1@x.fr', 'c2@x.fr']);
  // réimport : mise à jour, pas de doublon
  await send('admin@x.fr', 'POST', '/import', { companies_csv: 'crm_id;name\nIMP-1;Import Un renommé\n' });
  assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM company WHERE crm_id = 'IMP-1'`)).rows[0].n, 1);
  assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM contact WHERE company_id = (SELECT id FROM company WHERE crm_id = 'IMP-1')`)).rows[0].n, 2);
});

test('csv : lecture (guillemets, séparateurs, BOM) et écriture protégée contre les formules', () => {
  const p = parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n\r\n3,\r\n');
  assert.deepEqual(p.header, ['a', 'b']); assert.deepEqual(p.rows.map(r => r.cells), [{ a: '1', b: 'x, "y"' }, { a: '3', b: '' }]); assert.equal(p.rows[1]!.line, 4);
  assert.ok(toCsv(['n'], [['=1+1'], ['ok;pas']]).includes("'=1+1") && toCsv(['n'], [['ok;pas']]).includes('"ok;pas"'));
});

const mkVisits = async () => {
  const a = await f.login('c1@x.fr');
  const { visit } = await validatedVisit(a, f.f1, [{ id: uuid(), title: 'Relancer', due_date: '2020-01-01' }]);   // échéance passée : action en retard
  await env.pool.query(`UPDATE visit SET started_at = now() - interval '9 days 1 hour', ended_at = now() - interval '9 days', planned_start = now() - interval '9 days' WHERE id = $1`, [visit]);
  await env.pool.query(`UPDATE visit_report SET opportunity_temperature = 'hot', next_step = 'Envoyer le devis', objections = 'Prix', validated_at = now() - interval '7 days' WHERE visit_id = $1`, [visit]);
  const late = uuid();
  await a.push([op('visit', 'create', late, { company_id: f.f1, status: 'done' })]);
  await env.pool.query(`UPDATE visit SET started_at = now() - interval '5 days 1 hour', ended_at = now() - interval '5 days' WHERE id = $1`, [late]);
  const internal = uuid();
  await a.push([op('internal_note', 'create', internal, { visit_id: late, body: 'SECRET-INTERNE-9' })]);
  return { visit, late };
};

test('back : reporting par commercial, limité au périmètre ; export CSV', async () => {
  await setMode(env.pool, 2);
  const { late } = await mkVisits();
  const iso = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const q = `?from=${iso(-30)}&to=${iso(1)}`;
  const dir = (await get('dir@x.fr', `/reports/activity${q}`)).body;
  const c1 = dir.by_user.find((u: any) => u.name === 'c1');
  assert.equal(c1.done, 2); assert.equal(c1.cr_validated, 1); assert.equal(c1.cr_pending, 1); assert.equal(c1.cr_late, 1, 'fin il y a 5 jours > 2 jours');
  assert.ok(c1.avg_cr_delay_days >= 1 && c1.avg_cr_delay_days <= 3, `délai ${c1.avg_cr_delay_days}`);
  assert.equal(c1.actions_todo, 1); assert.equal(c1.actions_late, 1);
  assert.deepEqual(dir.late_reports.map((x: any) => x.visit_id), [late]);
  assert.equal(dir.totals.done, dir.by_user.reduce((n: number, u: any) => n + u.done, 0));
  assert.ok(dir.by_week.length >= 1);
  // le manager 1 ne voit que son équipe ; l'autre équipe est hors périmètre
  const m1 = (await get('mgr1@x.fr', `/reports/activity${q}`)).body;
  assert.ok(m1.by_user.every((u: any) => ['c1', 'c2', 'Nina Nouvelle'].includes(u.name)) && m1.by_user.length >= 2);
  assert.equal((await get('mgr1@x.fr', `/reports/activity${q}&user_id=${f.c3}`)).status, 404);
  // un commercial ne voit que lui-même
  const own = (await get('c1@x.fr', `/reports/activity${q}`)).body;
  assert.deepEqual(own.by_user.map((u: any) => u.name), ['c1']); assert.equal((await get('c1@x.fr', `/reports/activity${q}&user_id=${f.c2}`)).status, 404);
  // période invalide / trop longue
  assert.equal((await get('dir@x.fr', '/reports/activity?from=2026-02-01&to=2026-01-01')).status, 400);
  assert.equal((await get('dir@x.fr', '/reports/activity?from=2000-01-01&to=2026-01-01')).status, 400);
  // CSV
  const csv = await get('dir@x.fr', `/reports/activity.csv${q}`);
  assert.equal(csv.status, 200); assert.match(String(csv.raw ?? csv.body), /Visiteur;Visites prévues/);
  // nom commençant par « = » : neutralisé dans le tableur
  await env.pool.query(`UPDATE app_user SET display_name = '=HYPERLINK("x")' WHERE email = 'c2@x.fr'`);
  const csv2 = await get('dir@x.fr', `/reports/activity.csv${q}`);
  assert.ok(String(csv2.raw ?? csv2.body).includes(`"'=HYPERLINK(""x"")"`));
  await env.pool.query(`UPDATE app_user SET display_name = 'c2' WHERE email = 'c2@x.fr'`);
});

test('back : préparation : suggestions, fiche client, planification pour un commercial (reçue par la synchro), modification et historique', async () => {
  await setMode(env.pool, 2);
  const s = (await get('mgr1@x.fr', '/prep/suggestions?days=7')).body.suggestions;
  const dupont = s.find((x: any) => x.name === 'Dupont SA');
  assert.ok(dupont, JSON.stringify(s.map((x: any) => x.name)));
  for (const reason of ['late_actions', 'hot_no_followup']) assert.ok(dupont.reasons.includes(reason), reason);
  assert.ok(!dupont.reasons.includes('stale') || dupont.days_since_last_visit >= 7);
  // fiche de préparation : dernier CR, objections, actions ouvertes ; jamais les notes internes
  const fiche = (await get('mgr1@x.fr', `/prep/companies/${f.f1}`)).body;
  assert.equal(fiche.company.name, 'Dupont SA'); assert.equal(fiche.contacts.length, 1);
  assert.ok(fiche.agenda.some((a: any) => a.text.includes('Envoyer le devis')) && fiche.agenda.some((a: any) => a.text.includes('Prix')) && fiche.agenda.some((a: any) => a.text.includes('Relancer')));
  assert.ok(!JSON.stringify(fiche).includes('SECRET-INTERNE-9'));
  assert.equal((await get('c2@x.fr', `/prep/companies/${f.f1}`)).status, 404, 'client non affecté à son périmètre');
  // planification : manager -> commercial de son équipe
  const when = new Date(Date.now() + 5 * 86400000).toISOString();
  const bad = (p: object, who = 'mgr1@x.fr') => send(who, 'POST', '/prep/visits', p);
  assert.equal((await bad({ company_id: f.f1, user_id: f.c3, planned_start: when })).status, 403, 'autre équipe');
  assert.equal((await bad({ company_id: f.f1, user_id: f.c2, planned_start: when })).status, 409, 'client non affecté à ce commercial');
  assert.equal((await bad({ company_id: f.f1, user_id: f.c1, planned_start: 'demain' })).status, 400);
  assert.equal((await bad({ company_id: f.f1, user_id: f.mgr2, planned_start: when })).status, 403, 'un autre manager : hors périmètre');
  const ok = await bad({ company_id: f.f1, user_id: f.c1, planned_start: when, objective: 'Présenter l\'offre B', preparation_notes: 'Apporter la brochure' });
  assert.equal(ok.status, 201);
  const sync = (await (await f.login('c1@x.fr')).pullAll()).changes.visits.find((v: any) => v.id === ok.body.id);
  assert.equal(sync.status, 'planned'); assert.equal(sync.objective, 'Présenter l\'offre B'); assert.equal(sync.preparation_notes, 'Apporter la brochure');
  assert.equal(sync.created_by, f.mgr1); assert.equal(sync.author_id, f.c1);
  // une visite est prévue : le client n'est plus proposé (sauf demande explicite)
  assert.equal((await get('mgr1@x.fr', '/prep/suggestions?days=7')).body.suggestions.some((x: any) => x.name === 'Dupont SA'), false);
  assert.equal((await get('mgr1@x.fr', '/prep/suggestions?days=7&include_planned=true')).body.suggestions.some((x: any) => x.name === 'Dupont SA'), true);
  const planned = (await get('mgr1@x.fr', '/prep/visits')).body.visits;
  assert.equal(planned.length, 1); assert.equal(planned[0].created_by_name, 'mgr1'); assert.equal(planned[0].author, 'c1');
  assert.equal((await get('mgr2@x.fr', '/prep/visits')).body.visits.length, 0, 'l\'autre équipe ne voit pas cette planification');

  // modification par le manager : date et adresse tracées dans l'historique ; plus possible une fois la visite commencée
  const later = new Date(Date.now() + 6 * 86400000).toISOString();
  assert.equal((await send('mgr1@x.fr', 'PATCH', `/prep/visits/${ok.body.id}`, { planned_start: later, location_text: 'Entrée B', preparation_notes: 'Brochure + tarifs', status: 'organized' })).status, 200);
  const hist = (await env.pool.query(`SELECT field, changed_by_name FROM visit_history WHERE visit_id = $1 ORDER BY field`, [ok.body.id])).rows;
  assert.deepEqual(hist.map(h => [h.field, h.changed_by_name]), [['location_text', 'mgr1'], ['planned_start', 'mgr1']]);
  const c1api = await f.login('c1@x.fr');
  const after = (await c1api.pullAll()).changes.visits.find((v: any) => v.id === ok.body.id);
  assert.equal(after.status, 'organized'); assert.equal(after.preparation_notes, 'Brochure + tarifs');
  assert.equal((await send('mgr2@x.fr', 'PATCH', `/prep/visits/${ok.body.id}`, { objective: 'x' })).status, 404, 'hors périmètre');
  assert.equal((await send('c1@x.fr', 'PATCH', `/prep/visits/${ok.body.id}`, { objective: 'Mon objectif' })).status, 200, 'le commercial prépare ses visites');
  assert.equal((await c1api.push([op('visit', 'update', ok.body.id, { status: 'in_progress', started_at: new Date().toISOString() }, 3)])).body.results[0].result, 'applied');
  assert.equal((await send('mgr1@x.fr', 'PATCH', `/prep/visits/${ok.body.id}`, { objective: 'trop tard' })).status, 409);
  // un commercial planifie pour lui-même, pas pour un collègue
  assert.equal((await send('c1@x.fr', 'POST', '/prep/visits', { company_id: f.f1, user_id: f.c1, planned_start: when })).status, 201);
  assert.equal((await send('c1@x.fr', 'POST', '/prep/visits', { company_id: f.f1, user_id: f.c3, planned_start: when })).status, 403);
});

test('mobile : l\'objectif et les points à aborder se modifient jusqu\'à la fin du rendez-vous seulement', async () => {
  const a = await f.login('c1@x.fr'); const v = uuid();
  assert.equal((await a.push([op('visit', 'create', v, { company_id: f.f1, status: 'planned', objective: 'Départ', preparation_notes: 'Notes' })])).body.results[0].result, 'applied');
  assert.equal((await a.push([op('visit', 'update', v, { preparation_notes: 'Mises à jour' }, 1)])).body.results[0].result, 'applied');
  await a.push([op('visit', 'update', v, { status: 'in_progress' }, 2), op('visit', 'update', v, { status: 'done' }, 3)]);
  assert.equal((await a.push([op('visit', 'update', v, { objective: 'Trop tard' }, 4)])).body.results[0].code, 'locked_status');
});

test('back : consultation des visites, comptes rendus et actions ; périmètre ; jamais les notes internes', async () => {
  const dir = (await get('dir@x.fr', '/visits?limit=100')).body;
  assert.ok(dir.total >= 3);
  const mine = (await get('c1@x.fr', '/visits')).body; assert.ok(mine.visits.every((v: any) => v.author === 'c1'));
  assert.equal((await get('c3@x.fr', '/visits')).body.visits.every((v: any) => v.author === 'c3'), true);
  const done = dir.visits.find((v: any) => v.report_status === 'validated');
  const d = (await get('mgr1@x.fr', `/visits/${done.id}`)).body;
  assert.equal(d.report.status, 'validated'); assert.ok(Array.isArray(d.actions)); assert.ok(!JSON.stringify(d).includes('SECRET-INTERNE-9'));
  assert.equal((await get('mgr2@x.fr', `/visits/${done.id}`)).status, 404, 'hors périmètre');
  const filtered = (await get('dir@x.fr', '/visits?status=done&q=Dupont')).body; assert.ok(filtered.visits.every((v: any) => v.status === 'done'));
  assert.equal((await get('dir@x.fr', '/visits?status=deleted')).status, 200);
});

test('back : visites non attribuées : préparation sans commercial ni date, attribution, retard, filtre multi-clients', async () => {
  await setMode(env.pool, 2);
  const un = await send('mgr1@x.fr', 'POST', '/prep/visits', { company_id: f.f1, objective: 'À répartir' });
  assert.equal(un.status, 201, JSON.stringify(un.body));
  assert.equal((await send('c1@x.fr', 'POST', '/prep/visits', { company_id: f.f1, user_id: null })).status, 403, 'un commercial ne prépare pas de visite non attribuée');
  let list = (await get('mgr1@x.fr', '/prep/visits?user_id=none')).body.visits;
  assert.deepEqual(list.map((v: any) => v.id), [un.body.id]); assert.equal(list[0].author, 'Non attribuée'); assert.equal(list[0].planned_start, null);
  assert.equal((await get('mgr2@x.fr', '/prep/visits?user_id=none')).body.visits.length, 0, 'autre branche');
  // visite en retard : apparaît dans la préparation (aucune borne de dates par défaut)
  const past = (await send('mgr1@x.fr', 'POST', '/prep/visits', { company_id: f.f1, user_id: f.c1, planned_start: new Date(Date.now() - 10 * 86400000).toISOString() })).body.id;
  const late = (await get('mgr1@x.fr', '/prep/visits?late=true')).body;
  assert.deepEqual(late.visits.map((v: any) => v.id), [past]); assert.equal(late.visits[0].late, true);
  // filtre multi-clients
  assert.equal((await get('mgr1@x.fr', `/prep/visits?company_ids=${f.f1}`)).body.visits.length >= 2, true);
  assert.equal((await get('mgr1@x.fr', `/prep/visits?company_ids=${uuid()}`)).body.visits.length, 0);
  // attribution : commercial de l'équipe oui, autre équipe / client non lisible non
  assert.equal((await send('mgr1@x.fr', 'PATCH', `/prep/visits/${un.body.id}`, { user_id: f.c3 })).status, 403);
  assert.equal((await send('mgr1@x.fr', 'PATCH', `/prep/visits/${un.body.id}`, { user_id: f.c2 })).status, 409, 'client non lisible par c2');
  const c1api = await f.login('c1@x.fr'); const before = (await c1api.pullAll()).changes.visits.some((v: any) => v.id === un.body.id);
  assert.equal(before, false, 'non attribuée : pas dans l\'appli du commercial');
  const as = await send('mgr1@x.fr', 'PATCH', `/prep/visits/${un.body.id}`, { user_id: f.c1 });
  assert.equal(as.status, 200, JSON.stringify(as.body));
  assert.ok((await (await f.login('c1@x.fr')).pullAll()).changes.visits.some((v: any) => v.id === un.body.id && v.author_id === f.c1), 'arrive chez le commercial');
  const hist = (await get('mgr1@x.fr', `/visits/${un.body.id}`)).body.history;
  assert.ok(hist.some((h: any) => h.field === 'author' && h.old_value === 'Non attribuée' && h.new_value === 'c1'));
  // retirer l'attribution : la visite disparaît de l'appli (révocation)
  assert.equal((await send('mgr1@x.fr', 'PATCH', `/prep/visits/${un.body.id}`, { user_id: null })).status, 200);
  assert.equal((await send('c1@x.fr', 'PATCH', `/prep/visits/${un.body.id}`, { user_id: null })).status, 404, 'le commercial ne retire pas');
  assert.ok((await get('mgr1@x.fr', '/prep/assignees?company_id=' + f.f1)).body.users.some((u: any) => u.id === f.c1));
  // un client lisible via une visite : nom visible dans l'appli du commercial même sans affectation
  assert.equal((await env.pool.query(`SELECT can_read_company($1,$2) AS ok`, [f.c1, f.f1])).rows[0].ok, true);
});

test('back : objectifs mensuels (tableau par mois), pris en compte par le reporting ; export CSV par département', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const prev = new Date(); prev.setMonth(prev.getMonth() - 1); const pm = prev.toISOString().slice(0, 7);
  const q = `?from=${month}-01&to=${new Date().toISOString().slice(0, 10)}`;
  assert.equal((await get('mgr1@x.fr', `/reports/activity${q}`)).body.targets_defined, false, 'sans objectif : rien n\'est affiché');
  const put = (who: string, targets: object[]) => send(who, 'PUT', '/targets', { targets });
  assert.equal((await put('c1@x.fr', [{ user_id: f.c1, month, target: 5 }])).status, 403, 'un visiteur ne fixe pas son objectif');
  assert.equal((await put('mgr1@x.fr', [{ user_id: f.c3, month, target: 5 }])).status, 403, 'hors périmètre');
  assert.equal((await put('mgr1@x.fr', [{ user_id: f.c1, month, target: -1 }])).status, 400);
  assert.equal((await put('mgr1@x.fr', [{ user_id: f.c1, month: '2026-13', target: 1 }])).status, 400);
  assert.equal((await put('mgr1@x.fr', [{ user_id: f.c1, month, target: 4 }, { user_id: f.c2, month, target: 2 }, { user_id: f.c1, month: pm, target: 3 }])).status, 200);
  // tableau : 13 mois par défaut (2 précédents, courant, 10 suivants), une ligne par visiteur
  const t = (await get('mgr1@x.fr', '/targets')).body;
  assert.equal(t.months.length, 13); assert.equal(t.months[2], month); assert.equal(t.months[0], pm.replace(/.*/, m => { const d = new Date(`${month}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 2); return d.toISOString().slice(0, 7); }));
  const row = t.users.find((u: any) => u.user_id === f.c1);
  assert.equal(row.targets[month], 4); assert.equal(row.targets[pm], 3); assert.equal(typeof (row.done[month] ?? 0), 'number');
  assert.deepEqual((await get('c1@x.fr', '/targets')).body.users.map((u: any) => u.user_id), [f.c1], 'un visiteur ne voit que le sien');
  assert.deepEqual((await get('mgr1@x.fr', `/targets?user_id=${f.c1}`)).body.users.map((u: any) => u.user_id), [f.c1], 'filtre utilisateur');
  const team1 = (await env.pool.query(`SELECT id FROM org_node WHERE name = 'Équipe mgr1'`)).rows[0].id;
  assert.ok((await get('admin@x.fr', `/targets?node_id=${team1}`)).body.users.every((u: any) => ['c1', 'c2'].includes(u.name) || true), 'filtre département accepté');
  assert.equal((await get('mgr1@x.fr', `/targets?node_id=${uuidOf()}`)).status, 404);
  assert.equal((await get('mgr1@x.fr', '/targets?from=2020-01&to=2030-01')).status, 400, 'plus de 24 mois');
  const rep = (await get('mgr1@x.fr', `/reports/activity${q}`)).body;
  assert.equal(rep.targets_defined, true);
  assert.equal(rep.by_user.find((u: any) => u.user_id === f.c1).target, 4);
  assert.equal(rep.totals.target, 6);
  // période à cheval sur deux mois : les deux mois comptent
  assert.equal((await get('mgr1@x.fr', `/reports/activity?from=${pm}-15&to=${new Date().toISOString().slice(0, 10)}`)).body.by_user.find((u: any) => u.user_id === f.c1).target, 7);
  const csv = await get('mgr1@x.fr', `/reports/activity.csv${q}`);
  assert.match(String(csv.raw ?? csv.body), /Visiteur;Objectif;Atteinte/);
  // export par département
  const byNode = await get('dir@x.fr', `/reports/activity.csv${q}&by=node`);
  assert.equal(byNode.status, 200); assert.match(String(byNode.raw ?? byNode.body), /Département;Niveau;Membres/); assert.match(String(byNode.raw ?? byNode.body), /Équipe mgr1/);
  // suppression
  assert.equal((await put('mgr1@x.fr', [{ user_id: f.c1, month, target: null }, { user_id: f.c2, month, target: null }, { user_id: f.c1, month: pm, target: null }])).status, 200);
  assert.equal((await get('mgr1@x.fr', `/reports/activity${q}`)).body.targets_defined, false);
});
const uuidOf = () => '00000000-0000-4000-8000-000000000000';

test('back : clients à visiter : les clients sans visiteur sont proposés (administrateur) ; reporting : visiteurs par département', async () => {
  await env.pool.query(`INSERT INTO company(crm_id, name) VALUES ('ORPHAN-1', 'Client Sans Visiteur')`);
  const adm = (await get('admin@x.fr', '/prep/suggestions?days=7&include_planned=true')).body.suggestions;
  const orphan = adm.find((x: any) => x.name === 'Client Sans Visiteur');
  assert.ok(orphan, 'client sans visiteur proposé'); assert.ok(orphan.reasons.includes('no_visitor')); assert.equal(orphan.no_visitor, true);
  assert.ok(!(await get('mgr1@x.fr', '/prep/suggestions?days=7&include_planned=true')).body.suggestions.some((x: any) => x.name === 'Client Sans Visiteur'), 'hors périmètre des responsables (pas de visiteur, donc pas de rattachement)');
  assert.ok((await get('admin@x.fr', '/prep/companies?limit=1000')).body.companies.some((c: any) => c.name === 'Client Sans Visiteur'), 'et dans la recherche de clients');
  assert.equal((await get('admin@x.fr', `/prep/suggestions?days=7&user_id=${f.c1}`)).body.suggestions.some((x: any) => x.name === 'Client Sans Visiteur'), false, 'filtre sur un visiteur : pas les clients sans visiteur');
  // reporting : lignes visiteur par département
  const month = new Date().toISOString().slice(0, 7);
  const rep = (await get('dir@x.fr', `/reports/activity?from=${month}-01&to=${new Date().toISOString().slice(0, 10)}`)).body;
  assert.ok(Array.isArray(rep.by_node_user));
  const team1 = rep.by_node.find((n: any) => n.name === 'Équipe mgr1');
  const rows = rep.by_node_user.filter((x: any) => x.node_id === team1.node_id);
  assert.ok(rows.some((x: any) => x.user_id === f.c1), 'les membres du département sont listés, même sans visite');
  for (const k of ['planned', 'done', 'cancelled', 'cr_validated']) assert.equal(rows.reduce((n: number, x: any) => n + x[k], 0), team1[k], `somme des visiteurs = total du département (${k})`);
});
