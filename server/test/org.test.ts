import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, createCompany, op, uuid, setMode, Api, PASSWORD, type TestEnv } from './helpers.js';

// Organisation de test :
//   Entreprise
//   ├─ Région A      (dirA : directeur)
//   │   ├─ Agence A1 (mgrA1 : manager ; dirAg1 : directeur d'agence ; cA1 : commercial)
//   │   └─ Agence A2 (mgrA2 : manager ; cA2 : commercial)
//   └─ Région B      (dirB : directeur)
//       └─ Agence B1 (mgrB1 : manager ; cB1 : commercial)
//   cMulti : commercial affecté à A1 et B1.   admin : administrateur, hors arbre.
let env: TestEnv;
const N: Record<string, string> = {};     // nœuds par nom
const U: Record<string, string> = {};     // utilisateurs par identifiant court
const B = '/api/back/v1';
const email = (k: string) => `${k.toLowerCase()}@org.fr`;
const logins = new Map<string, Api>();
const as = async (k: string) => { let a = logins.get(k); if (!a) { a = new Api(env.base); const r = await a.login(email(k), PASSWORD); assert.equal(r.status, 200, k); logins.set(k, a); } return a; };
const back = async (k: string, method: string, path: string, body?: unknown) => (await as(k)).call(method, B + path, method === 'GET' ? undefined : body ?? {});
const visitsOf = async (k: string) => ((await (await as(k)).pullAll()).changes.visits ?? []) as any[];
const V: Record<string, string> = {};     // visites par auteur

before(async () => {
  env = await setup();
  const { pool } = env;
  const hash = (await import('../src/auth.js')).hashPassword;
  const pwd = await hash(PASSWORD);
  const mk = async (k: string, role: string, admin = false) => {
    U[k] = (await pool.query(`INSERT INTO app_user(email, display_name, role, is_admin, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [email(k), k, role, admin, pwd])).rows[0].id;
  };
  for (const [k, role] of [['dirA', 'directeur'], ['dirB', 'directeur'], ['dirAg1', 'directeur'], ['mgrA1', 'manager'], ['mgrA2', 'manager'], ['mgrB1', 'manager'],
    ['cA1', 'commercial'], ['cA2', 'commercial'], ['cB1', 'commercial'], ['cMulti', 'commercial'], ['cNone', 'commercial']] as const) await mk(k, role);
  await mk('admin', 'commercial', true);
  // L'arbre est construit par l'API d'administration (ce qui la teste), puis les affectations aussi.
  const root = (await pool.query(`INSERT INTO org_node(name) VALUES ('Entreprise') RETURNING id`)).rows[0].id; N.Entreprise = root;
  await pool.query('SELECT rebuild_org()');
  const node = async (name: string, parent: string) => { const r = await back('admin', 'POST', '/org/nodes', { name, parent_id: N[parent] }); assert.equal(r.status, 201, name); N[name] = r.body.id; };
  await node('Région A', 'Entreprise'); await node('Région B', 'Entreprise');
  await node('Agence A1', 'Région A'); await node('Agence A2', 'Région A'); await node('Agence B1', 'Région B');
  const place = async (k: string, ...nodes: string[]) => { const r = await back('admin', 'PATCH', `/users/${U[k]}`, { node_ids: nodes.map(n => N[n]) }); assert.equal(r.status, 200, k); };
  await place('dirA', 'Région A'); await place('dirB', 'Région B');
  await place('mgrA1', 'Agence A1'); await place('dirAg1', 'Agence A1'); await place('cA1', 'Agence A1');
  await place('mgrA2', 'Agence A2'); await place('cA2', 'Agence A2');
  await place('mgrB1', 'Agence B1'); await place('cB1', 'Agence B1');
  await place('cMulti', 'Agence A1', 'Agence B1');
  const everyone = ['cA1', 'cA2', 'cB1', 'cMulti', 'cNone'].map(k => U[k]!);
  U.company = await createCompany(pool, 'ORG-1', everyone, 'Client commun');
  // une visite par commercial, dans sa branche
  for (const k of ['cA1', 'cA2', 'cB1']) {
    V[k] = uuid();
    const r = await (await as(k)).push([op('visit', 'create', V[k], { company_id: U.company, status: 'in_progress', started_at: new Date().toISOString(), location_text: k })]);
    assert.equal(r.body.results[0].result, 'applied', k);
  }
});
after(async () => { await env.close(); });

const seen = async (k: string) => { const ids = new Set((await visitsOf(k)).map(v => v.id)); return Object.fromEntries(['cA1', 'cA2', 'cB1'].map(a => [a, ids.has(V[a]!)])); };

test('organisation : seuls les administrateurs modifient l\'arbre ; chacun lit ses branches ; règles de nom, de déplacement et de suppression', async () => {
  for (const [m, p, b] of [['POST', '/org/nodes', { name: 'X', parent_id: N.Entreprise }], ['PATCH', `/org/nodes/${N['Agence A1']}`, { name: 'Y' }], ['DELETE', `/org/nodes/${N['Agence A1']}`, {}]] as const) {
    assert.equal((await back('dirA', m, p, b)).status, 403, `${m} ${p} : directeur`);
  }
  assert.equal((await back('mgrA1', 'GET', '/org')).status, 403, 'l\'arbre complet est réservé aux administrateurs');
  const mine = (await back('dirA', 'GET', '/org/mine')).body;
  assert.deepEqual(mine.mine.map((n: any) => n.path), ['Entreprise › Région A']);
  assert.deepEqual(mine.access.map((n: any) => n.name), ['Région A', 'Agence A1', 'Agence A2'], 'sa branche : lui et ses descendants, pas la région B');
  assert.deepEqual((await back('cA1', 'GET', '/org/mine')).body.access.map((n: any) => n.name), ['Agence A1']);
  assert.equal((await back('admin', 'GET', '/org/mine')).body.access.length, 6, 'l\'administrateur accède à tout l\'arbre');
  const tree = (await back('admin', 'GET', '/org')).body.nodes;
  const a1 = tree.find((n: any) => n.name === 'Agence A1');
  assert.deepEqual(a1.members.map((m: any) => m.name).sort(), ['cA1', 'cMulti', 'dirAg1', 'mgrA1']); assert.equal(a1.visits_count, 1); assert.equal(a1.depth, 2);
  // nom en double sous le même parent
  assert.equal((await back('admin', 'POST', '/org/nodes', { name: 'agence a1', parent_id: N['Région A'] })).status, 409);
  assert.equal((await back('admin', 'POST', '/org/nodes', { name: 'Agence A1', parent_id: N['Région B'] })).status, 201, 'même nom sous un autre parent : accepté');
  const dup = (await back('admin', 'GET', '/org')).body.nodes.find((n: any) => n.path === 'Entreprise › Région B › Agence A1').id;
  assert.equal((await back('admin', 'DELETE', `/org/nodes/${dup}`)).status, 200, 'branche vide : supprimée');
  // cycle et racine
  assert.equal((await back('admin', 'PATCH', `/org/nodes/${N['Région A']}`, { parent_id: N['Agence A1'] })).status, 409, 'sous une de ses descendantes');
  assert.equal((await back('admin', 'PATCH', `/org/nodes/${N.Entreprise}`, { parent_id: N['Région A'] })).status, 409, 'la racine ne bouge pas');
  assert.equal((await back('admin', 'DELETE', `/org/nodes/${N.Entreprise}`)).status, 409);
  // suppression : sous-branches, membres, visites
  assert.equal((await back('admin', 'DELETE', `/org/nodes/${N['Région A']}`)).body.code, 'has_children');
  assert.equal((await back('admin', 'DELETE', `/org/nodes/${N['Agence A2']}`)).body.code, 'has_members');
  assert.equal((await back('admin', 'POST', '/org/nodes', { name: 'Vide', parent_id: N.Entreprise })).status, 201);
  // renommage conserve l'identité
  assert.equal((await back('admin', 'PATCH', `/org/nodes/${N['Agence B1']}`, { name: 'Agence B1 (Lyon)' })).status, 200);
  assert.equal((await back('admin', 'PATCH', `/org/nodes/${N['Agence B1']}`, { name: 'Agence B1' })).status, 200);
});

test('droits : chacun ne voit que ses branches ; un directeur d\'agence ne voit pas l\'autre agence ; la direction voit les sous-branches de façon consolidée (application mobile)', async () => {
  await setMode(env.pool, 2);
  assert.deepEqual(await seen('cA1'), { cA1: true, cA2: false, cB1: false }, 'un commercial : les siennes');
  assert.deepEqual(await seen('mgrA1'), { cA1: true, cA2: false, cB1: false }, 'manager d\'agence');
  assert.deepEqual(await seen('dirAg1'), { cA1: true, cA2: false, cB1: false }, 'directeur d\'agence : sa branche seulement, pas l\'agence voisine');
  assert.deepEqual(await seen('mgrA2'), { cA1: false, cA2: true, cB1: false });
  assert.deepEqual(await seen('dirA'), { cA1: true, cA2: true, cB1: false }, 'directeur de région : consolidé sur ses agences');
  assert.deepEqual(await seen('dirB'), { cA1: false, cA2: false, cB1: true });
  assert.deepEqual(await seen('mgrB1'), { cA1: false, cA2: false, cB1: true });
  assert.deepEqual(await seen('admin'), { cA1: false, cA2: false, cB1: false }, 'l\'administrateur IT ne lit pas le contenu par ce seul rôle sur mobile');
  // les données dépendantes suivent : notes durant visite, compte rendu, actions, notes internes
  const a = await as('cA1');
  await a.push([op('note', 'create', uuid(), { visit_id: V.cA1, kind: 'text', body: 'Note A1' }), op('internal_note', 'create', uuid(), { visit_id: V.cA1, body: 'Interne A1' })]);
  const rowsOf = async (k: string, key: string) => (((await (await as(k)).pullAll()).changes as any)[key] ?? []) as any[];
  assert.equal((await rowsOf('dirA', 'notes')).some(n => n.body === 'Note A1'), true);
  assert.equal((await rowsOf('dirA', 'internal_notes')).some(n => n.body === 'Interne A1'), true, 'consolidé : la note interne remonte à la direction de région');
  assert.equal((await rowsOf('mgrA2', 'internal_notes')).length, 0, 'manager d\'une autre agence : rien');
  assert.equal((await rowsOf('dirB', 'notes')).length, 0);
  // le client commun est lisible par tous ceux qui ont un commercial affecté dans leur branche
  for (const k of ['dirA', 'dirB', 'mgrA1']) assert.equal((await rowsOf(k, 'companies')).some(c => c.id === U.company), true, k);
});

test('mode 1 : un commercial voit les visites de ses collègues du client seulement dans ses propres branches', async () => {
  await setMode(env.pool, 1);
  try {
    assert.deepEqual(await seen('cA1'), { cA1: true, cA2: false, cB1: false }, 'cA2 est dans une autre agence : invisible même sur le même client');
    const multi = await seen('cMulti');                    // cMulti est dans A1 et B1 : il voit les visites de ses deux branches
    assert.deepEqual(multi, { cA1: true, cA2: false, cB1: true });
  } finally { await setMode(env.pool, 2); }
});

test('une visite appartient à une branche de son auteur : choix obligatoire s\'il y en a plusieurs, refus d\'une branche étrangère, de l\'absence de branche', async () => {
  const x = await as('cMulti'); const id = uuid();
  const base = { company_id: U.company, status: 'planned' };
  const noChoice = (await x.push([op('visit', 'create', id, base)])).body.results[0];
  assert.equal(noChoice.result, 'rejected'); assert.equal(noChoice.code, 'org_node_required');
  const foreign = (await x.push([op('visit', 'create', id, { ...base, org_node_id: N['Agence A2'] })])).body.results[0];
  assert.equal(foreign.code, 'validation_failed', 'une branche qui n\'est pas la sienne');
  const ok = (await x.push([op('visit', 'create', id, { ...base, org_node_id: N['Agence B1'] })])).body.results[0];
  assert.equal(ok.result, 'applied');
  assert.deepEqual((await visitsOf('mgrB1')).some(v => v.id === id), true); assert.equal((await visitsOf('mgrA1')).some(v => v.id === id), false, 'branche A1 : pas cette visite');
  const row = (await visitsOf('cMulti')).find(v => v.id === id);
  assert.equal(row.org_node_id, N['Agence B1']); assert.equal(row.org_node_name, 'Agence B1');
  // la branche ne se modifie pas après coup
  assert.equal((await x.push([op('visit', 'update', id, { org_node_id: N['Agence A1'] }, 1)])).body.results[0].code, 'validation_failed');
  // sans branche
  const none = (await (await as('cNone')).push([op('visit', 'create', uuid(), base)])).body.results[0];
  assert.equal(none.code, 'no_org_node');
  // une seule branche : choisie automatiquement
  assert.equal((await (await as('cA1')).push([op('visit', 'create', uuid(), base)])).body.results[0].result, 'applied');
  // /me : branches de l'utilisateur
  const me = (await x.call('GET', '/api/mobile/v1/me')).body;
  assert.deepEqual(me.nodes.map((n: any) => n.path), ['Entreprise › Région A › Agence A1', 'Entreprise › Région B › Agence B1']);
});

test('application back : reporting, visites et préparation limités aux branches ; consolidation par branche ; filtre sur une branche', async () => {
  const iso = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const q = `?from=${iso(-30)}&to=${iso(1)}`;
  const names = (r: any) => r.by_node.map((n: any) => n.name);
  const dirA = (await back('dirA', 'GET', `/reports/activity${q}`)).body;
  assert.deepEqual(names(dirA), ['Région A', 'Agence A1', 'Agence A2'], 'la branche de la région A seulement');
  const cons = Object.fromEntries(dirA.by_node.map((n: any) => [n.name, n.in_progress]));
  assert.ok(cons['Agence A1'] >= 1 && cons['Agence A2'] === 1, JSON.stringify(cons));
  assert.equal(cons['Région A'], cons['Agence A1'] + cons['Agence A2'], 'consolidé : la région cumule ses agences');
  assert.deepEqual(dirA.by_user.map((u: any) => u.name).sort(), ['cA1', 'cA2', 'cMulti'].filter(n => dirA.by_user.some((u: any) => u.name === n)).sort());
  assert.ok(!dirA.by_user.some((u: any) => u.name === 'cB1'));
  // descente dans une branche : seulement son sous-arbre ; hors périmètre : 404
  const a2 = (await back('dirA', 'GET', `/reports/activity${q}&node_id=${N['Agence A2']}`)).body;
  assert.deepEqual(names(a2), ['Agence A2']); assert.equal(a2.totals.in_progress, 1);
  assert.equal((await back('dirA', 'GET', `/reports/activity${q}&node_id=${N['Agence B1']}`)).status, 404);
  assert.equal((await back('mgrA1', 'GET', `/reports/activity${q}&node_id=${N['Agence A2']}`)).status, 404, 'agence voisine');
  const mgr = (await back('mgrA1', 'GET', `/reports/activity${q}`)).body;
  assert.deepEqual(names(mgr), ['Agence A1']);
  const admin = (await back('admin', 'GET', `/reports/activity${q}`)).body;
  assert.ok(admin.by_node.length >= 6, 'l\'administrateur voit tout l\'arbre');
  assert.equal(admin.by_node.find((n: any) => n.name === 'Entreprise').in_progress, admin.totals.in_progress, 'la racine consolide tout');
  // liste des visites
  const list = async (k: string) => (await back(k, 'GET', '/visits?limit=100')).body.visits.map((v: any) => v.author).filter((a: string) => ['cA1', 'cA2', 'cB1'].includes(a));
  assert.deepEqual([...new Set(await list('dirA'))].sort(), ['cA1', 'cA2']);
  assert.deepEqual([...new Set(await list('mgrA1'))].sort(), ['cA1']);
  assert.deepEqual([...new Set(await list('dirB'))].sort(), ['cB1']);
  assert.equal((await back('dirA', 'GET', `/visits/${V.cB1}`)).status, 404, 'détail d\'une autre région : inconnu');
  assert.equal((await back('dirA', 'GET', `/visits/${V.cA2}`)).status, 200);
  const byNode = (await back('dirA', 'GET', `/visits?node_id=${N['Agence A2']}`)).body.visits;
  assert.ok(byNode.length >= 1 && byNode.every((v: any) => v.org_path === 'Entreprise › Région A › Agence A2'));
  // préparation : fiche et planification
  const fiche = (await back('mgrB1', 'GET', `/prep/companies/${U.company}`)).body;
  assert.ok(fiche.visits.every((v: any) => v.author === 'cB1' || v.author === 'cMulti'), 'la fiche ne montre pas les visites des autres branches');
  // suggestions : un client affecté seulement à un commercial de l'agence A2, jamais visité
  const solo = await createCompany(env.pool, 'ORG-2', [U.cA2!], 'Client A2');
  const suggested = async (k: string) => (await back(k, 'GET', '/prep/suggestions?days=7')).body.suggestions.map((x: any) => x.name);
  assert.ok((await suggested('mgrA2')).includes('Client A2') && (await suggested('dirA')).includes('Client A2'), 'agence A2 et région A');
  assert.ok(!(await suggested('mgrA1')).includes('Client A2') && !(await suggested('dirB')).includes('Client A2'), 'agence A1 et région B : pas ce client');
  void solo;
  // planification : le commercial multi-branches
  const when = new Date(Date.now() + 5 * 86400000).toISOString();
  const plan = (k: string, body: object) => back(k, 'POST', '/prep/visits', { company_id: U.company, user_id: U.cMulti, planned_start: when, ...body });
  assert.equal((await plan('dirA', {})).status, 201, 'dirA n\'a accès qu\'à A1 : la branche est déduite');
  const amb = await plan('admin', {});
  assert.equal(amb.status, 409); assert.equal(amb.body.code, 'org_node_required'); assert.equal(amb.body.nodes.length, 2);
  assert.equal((await plan('admin', { node_id: N['Agence A2'] })).status, 409, 'branche qui n\'est pas celle du commercial');
  assert.equal((await plan('admin', { node_id: N['Agence B1'] })).status, 201);
  assert.equal((await plan('mgrA2', {})).status, 403, 'commercial hors de son périmètre');
  assert.equal((await back('mgrB1', 'GET', '/prep/visits')).body.visits.some((v: any) => v.author === 'cMulti' && v.org_path.endsWith('Agence B1')), true);
  assert.equal((await back('mgrA1', 'GET', '/prep/visits')).body.visits.some((v: any) => v.org_path.endsWith('Agence B1')), false);
});

test('déplacer une branche change les droits : retrait d\'accès côté appareil pour l\'ancienne direction, gain pour la nouvelle', async () => {
  const dirA = await as('dirA'); const dirB = await as('dirB');
  const firstA = await dirA.pullAll(); const firstB = await dirB.pullAll();
  assert.ok(firstA.changes.visits?.some((v: any) => v.id === V.cA2));
  assert.equal(firstB.changes.visits?.some((v: any) => v.id === V.cA2) ?? false, false);
  const mv = await back('admin', 'PATCH', `/org/nodes/${N['Agence A2']}`, { parent_id: N['Région B'] });
  assert.equal(mv.status, 200); assert.ok(mv.body.revoked > 0);
  const nextA = await dirA.pullAll(firstA.cursor);
  assert.ok(nextA.revocations.some(r => r.entity === 'visit' && r.entity_id === V.cA2), 'ancienne région : retrait');
  assert.ok((await visitsOf('dirB')).some(v => v.id === V.cA2), 'nouvelle région : accès');
  assert.equal((await visitsOf('mgrA2')).some(v => v.id === V.cA2), true, 'le manager de l\'agence la garde');
  assert.equal((await back('dirA', 'GET', `/visits/${V.cA2}`)).status, 404);
  // retour à l'état initial
  assert.equal((await back('admin', 'PATCH', `/org/nodes/${N['Agence A2']}`, { parent_id: N['Région A'] })).status, 200);
  assert.ok((await visitsOf('dirA')).some(v => v.id === V.cA2));
});

test('e-mail d\'une visite : seuls les supérieurs qui peuvent lire la visite sont proposés comme destinataires', async () => {
  const o = (await (await as('cA1')).call('GET', `/api/mobile/v1/visits/${V.cA1}/email-options`)).body;
  assert.deepEqual(o.recipients.map((r: any) => r.name).sort(), ['cA1', 'dirA', 'dirAg1', 'mgrA1']);
  assert.ok(!o.recipients.some((r: any) => ['mgrA2', 'dirB', 'mgrB1'].includes(r.name)));
});
