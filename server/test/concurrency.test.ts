import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, createUser, createCompany, op, uuid, Api, PASSWORD, type TestEnv } from './helpers.js';

const envs: TestEnv[] = [];
after(async () => { for (const e of envs) await e.close(); });

test('scénario 9 : une transaction qui valide en retard n\'est pas manquée grâce au recouvrement du curseur', async () => {
  const env = await setup({ syncOverlap: 50 }); envs.push(env);
  const f = await fixture(env);
  const a = await f.login('c1@x.fr');
  await env.pool.query(`SELECT setval('change_seq', 1000)`);   // numéros assez grands pour que le recul du curseur joue

  const t1 = await env.pool.connect(), t2 = await env.pool.connect();
  const ins = (c: typeof t1, id: string) => c.query(`INSERT INTO visit(id, company_id, author_id) VALUES ($1,$2,$3)`, [id, f.f1, f.c1]);
  const late = uuid(), early = uuid();
  await t1.query('BEGIN'); await ins(t1, late);     // numéro 1001, validera en dernier
  await t2.query('BEGIN'); await ins(t2, early);    // numéro 1002, validera en premier
  await t2.query('COMMIT');

  const first = await a.pullAll();
  assert.ok(first.changes.visits?.some(v => v.id === early));
  assert.ok(!first.changes.visits?.some(v => v.id === late), 'pas encore validée');

  await t1.query('COMMIT'); t1.release(); t2.release();
  const second = await a.pullAll(first.cursor);
  assert.ok(second.changes.visits?.some(v => v.id === late), 'la ligne validée en retard est récupérée');
});

test('scénario 9, contrôle négatif : sans recouvrement, la ligne en retard est manquée (le risque est réel)', async () => {
  const env = await setup({ syncOverlap: 0 }); envs.push(env);
  const f = await fixture(env);
  const a = await f.login('c1@x.fr');
  await env.pool.query(`SELECT setval('change_seq', 1000)`);
  const t1 = await env.pool.connect(), t2 = await env.pool.connect();
  const late = uuid(), early = uuid();
  const ins = (c: typeof t1, id: string) => c.query(`INSERT INTO visit(id, company_id, author_id) VALUES ($1,$2,$3)`, [id, f.f1, f.c1]);
  await t1.query('BEGIN'); await ins(t1, late);
  await t2.query('BEGIN'); await ins(t2, early); await t2.query('COMMIT');
  const first = await a.pullAll();
  await t1.query('COMMIT'); t1.release(); t2.release();
  const second = await a.pullAll(first.cursor);
  assert.ok(!second.changes.visits?.some(v => v.id === late), 'sans recouvrement, la ligne est perdue pour cet appareil');
});

test('pagination : la lecture par lots ne perd ni ne boucle, même avec peu de numéros', async () => {
  const env = await setup({ syncOverlap: 5 }); envs.push(env);
  const f = await fixture(env);
  const a = await f.login('c1@x.fr');
  const ids = Array.from({ length: 60 }, () => uuid());
  await a.push(ids.slice(0, 30).map(id => op('visit', 'create', id, { company_id: f.f1 })));
  await a.push(ids.slice(30).map(id => op('visit', 'create', id, { company_id: f.f1 })));
  const all = await a.pullAll();   // lots de 50
  const got = new Set(all.changes.visits!.map(v => v.id));
  for (const id of ids) assert.ok(got.has(id));
});

test('scénario 8 : 200 utilisateurs synchronisent en même temps, chacun ne voit que ses données', async () => {
  const env = await setup(); envs.push(env);
  const N = 200;
  const users: { email: string; company: string }[] = [];
  for (let i = 0; i < N; i++) {
    const email = `u${i}@x.fr`;
    const id = await createUser(env.pool, email, 'commercial');
    users.push({ email, company: await createCompany(env.pool, `C-${i}`, [id]) });
  }
  const t0 = Date.now();
  let failures = 0;
  const work = async (u: { email: string; company: string }) => {
    const a = new Api(env.base);
    if ((await a.login(u.email, PASSWORD)).status !== 200) { failures++; return; }
    const v = uuid();
    const r = await a.push([
      op('visit', 'create', v, { company_id: u.company, status: 'done' }),
      op('report', 'create', uuid(), { visit_id: v, language: 'fr', summary: u.email, status: 'validated', no_action: true,
        draft_actions: Array.from({ length: 3 }, (_, k) => ({ id: uuid(), title: `Action ${k}`, due_date: null, origin: 'manual' })) }),
    ]);
    if (!r.body.results.every((x: any) => x.result === 'applied')) { failures++; return; }
    const { changes } = await a.pullAll();
    if (changes.visits?.length !== 1 || changes.actions?.length !== 3 || changes.companies?.length !== 1 || changes.reports?.[0]?.summary !== u.email) failures++;
  };
  for (let i = 0; i < N; i += 50) await Promise.all(users.slice(i, i + 50).map(work));
  const secs = (Date.now() - t0) / 1000;
  console.log(`# 200 utilisateurs : ${secs.toFixed(1)} s`);
  assert.equal(failures, 0);
  assert.ok(secs < 120, `trop lent : ${secs}s`);
});
