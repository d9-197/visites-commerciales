import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fixture, op, uuid, setMode, validatedVisit, type TestEnv, type Fixture } from './helpers.js';
import type { MailMessage, MailService } from '../src/mail/index.js';

const sent: MailMessage[] = [];
let failNext = false;
const mail: MailService = { async send(m) { if (failNext) { failNext = false; throw new Error('smtp: connexion refusée'); } sent.push(m); } };
let env: TestEnv; let f: Fixture; let noMail: TestEnv;
before(async () => { env = await setup({}, { mail }); f = await fixture(env); noMail = await setup(); });
after(async () => { await env.close(); await noMail.close(); });

const SECRET = 'INFO-INTERNE-SECRETE-55';
const make = async () => {
  const a = await f.login('c1@x.fr');
  const { visit } = await validatedVisit(a, f.f1, [{ id: uuid(), title: 'Envoyer le devis <b>vite</b>', due_date: '2026-12-15' }]);
  return { a, visit };
};

test('e-mail : options (destinataires = soi + hiérarchie, contenu disponible) ; non configuré signalé', async () => {
  // note créée avant la fin de visite
  const a = await f.login('c1@x.fr'); const v = uuid();
  await a.push([op('visit', 'create', v, { company_id: f.f1, status: 'in_progress', location_text: '12 rue des Lilas' }),
    op('note', 'create', uuid(), { visit_id: v, kind: 'text', body: 'Budget de 40 000 euros' }),
    op('internal_note', 'create', uuid(), { visit_id: v, body: SECRET }),
    op('private_note', 'create', uuid(), { visit_id: v, body: SECRET })]);
  const o = await a.call('GET', `/api/mobile/v1/visits/${v}/email-options`);
  assert.equal(o.status, 200);
  assert.deepEqual(o.body.recipients.map((x: any) => [x.email, x.kind]), [['c1@x.fr', 'self'], ['mgr1@x.fr', 'hierarchy'], ['dir@x.fr', 'hierarchy']]);
  assert.deepEqual(o.body.parts, { report: false, actions: 0, notes: 1 });
  assert.equal(o.body.configured, true);
});

test('e-mail : envoi du compte rendu, des actions et des notes à soi et au manager ; jamais les notes internes ni privées ; échappement', async () => {
  sent.length = 0;
  const a = await f.login('c1@x.fr');
  const v = uuid(), r = uuid();
  const act = uuid();
  assert.equal((await a.push([
    op('visit', 'create', v, { company_id: f.f1, status: 'in_progress', location_text: '12 rue des Lilas' }),
    op('note', 'create', uuid(), { visit_id: v, kind: 'text', body: 'Budget de 40 000 euros <script>' }),
    op('internal_note', 'create', uuid(), { visit_id: v, body: SECRET }),
    op('private_note', 'create', uuid(), { visit_id: v, body: SECRET }),
    op('visit', 'update', v, { status: 'done' }, 1),
    op('report', 'create', r, { visit_id: v, language: 'fr', summary: 'Client intéressé.', next_step: 'Devis', status: 'validated',
      draft_actions: [{ id: act, title: 'Envoyer le devis <b>vite</b>', due_date: null, origin: 'manual' }] }),
  ])).body.results.every((x: any) => x.result === 'applied'), true);
  const ids = (await a.call('GET', `/api/mobile/v1/visits/${v}/email-options`)).body.recipients.map((x: any) => x.id);
  const res = await a.call('POST', `/api/mobile/v1/visits/${v}/email`, { recipient_ids: ids.slice(0, 2), parts: ['report', 'actions', 'notes'], message: 'Pour info' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.sent_to, ['c1@x.fr', 'mgr1@x.fr']);
  assert.equal(sent.length, 1);
  const m = sent[0]!;
  assert.deepEqual(m.to, ['c1@x.fr', 'mgr1@x.fr']); assert.equal(m.replyTo, 'c1@x.fr');
  assert.match(m.subject, /Dupont SA/);
  for (const t of [m.text, m.html]) {
    assert.ok(t.includes('Client intéressé.'), 'compte rendu'); assert.ok(t.includes('Pour info'), 'message');
    assert.ok(t.includes('Budget de 40 000 euros'), 'notes'); assert.ok(t.includes('12 rue des Lilas'), 'adresse');
    assert.ok(!t.includes(SECRET), 'notes internes et privées jamais envoyées');
  }
  assert.ok(m.html.includes('Envoyer le devis &lt;b&gt;vite&lt;/b&gt;') && !m.html.includes('<b>vite</b>'), 'HTML échappé');
  assert.ok(m.html.includes('&lt;script&gt;') && !m.html.includes('<script>'));
  const log = (await env.pool.query(`SELECT recipients, parts, status FROM visit_email WHERE visit_id = $1`, [v])).rows;
  assert.deepEqual(log, [{ recipients: ['c1@x.fr', 'mgr1@x.fr'], parts: ['report', 'actions', 'notes'], status: 'sent' }]);
  assert.ok(!JSON.stringify(log).includes('Client intéressé'), 'le contenu n\'est pas journalisé');

  // sélection partielle : seulement les actions
  sent.length = 0;
  await a.call('POST', `/api/mobile/v1/visits/${v}/email`, { recipient_ids: [ids[0]], parts: ['actions'] });
  assert.ok(sent[0]!.text.includes('Envoyer le devis') && !sent[0]!.text.includes('Client intéressé.') && !sent[0]!.text.includes('Budget'));
});

test('e-mail : destinataire hors hiérarchie refusé ; compte rendu non validé refusé ; visite illisible ; corps invalide', async () => {
  sent.length = 0;
  const a = await f.login('c1@x.fr'); const v = uuid();
  await a.push([op('visit', 'create', v, { company_id: f.f1, status: 'in_progress' }), op('report', 'create', uuid(), { visit_id: v, language: 'fr', summary: 'Brouillon' })]);
  const o = (await a.call('GET', `/api/mobile/v1/visits/${v}/email-options`)).body;
  const self = o.recipients[0].id;
  const c2 = (await env.pool.query(`SELECT id FROM app_user WHERE email = 'c2@x.fr'`)).rows[0].id;
  const mgr2 = (await env.pool.query(`SELECT id FROM app_user WHERE email = 'mgr2@x.fr'`)).rows[0].id;
  const post = (who: Awaited<ReturnType<typeof f.login>>, body: unknown, id = v) => who.call('POST', `/api/mobile/v1/visits/${id}/email`, body);
  assert.equal((await post(a, { recipient_ids: [self, c2], parts: ['notes'] })).status, 403, 'collègue');
  assert.equal((await post(a, { recipient_ids: [mgr2], parts: ['notes'] })).status, 403, 'manager d\'une autre équipe');
  const draft = await post(a, { recipient_ids: [self], parts: ['report'] });
  assert.equal(draft.status, 409); assert.equal(draft.body.code, 'report_not_validated');
  assert.equal((await post(a, { recipient_ids: [], parts: ['notes'] })).status, 400);
  assert.equal((await post(a, { recipient_ids: [self], parts: [] })).status, 400);
  assert.equal((await post(a, { recipient_ids: [self], parts: ['internal_notes'] })).status, 400, 'notes internes : pas une option');
  await setMode(env.pool, 2);
  const c3 = await f.login('c3@x.fr');
  assert.equal((await post(c3, { recipient_ids: [self], parts: ['notes'] })).status, 404, 'visite non visible');
  assert.equal((await c3.call('GET', `/api/mobile/v1/visits/${v}/email-options`)).status, 404);
  assert.equal(sent.length, 0, 'aucun envoi');
});

test('e-mail : un manager envoie à lui-même et à sa hiérarchie ; échec SMTP : 502 journalisé ; limite horaire ; sans SMTP : 503', async () => {
  await setMode(env.pool, 2);
  const { a, visit } = await make();
  const mg = await f.login('mgr1@x.fr');
  const o = (await mg.call('GET', `/api/mobile/v1/visits/${visit}/email-options`)).body;
  assert.deepEqual(o.recipients.map((x: any) => x.email), ['mgr1@x.fr', 'dir@x.fr']);
  const down = o.recipients.map((x: any) => x.id);
  sent.length = 0;
  assert.equal((await mg.call('POST', `/api/mobile/v1/visits/${visit}/email`, { recipient_ids: down, parts: ['report'] })).status, 200);
  assert.deepEqual(sent[0]!.to, ['mgr1@x.fr', 'dir@x.fr']);
  // échec du fournisseur
  failNext = true;
  const bad = await mg.call('POST', `/api/mobile/v1/visits/${visit}/email`, { recipient_ids: [down[0]], parts: ['report'] });
  assert.equal(bad.status, 502); assert.equal(bad.body.code, 'email_failed');
  assert.ok(!JSON.stringify(bad.body).includes('connexion refusée'), 'détail technique non exposé');
  assert.equal((await env.pool.query(`SELECT count(*)::int AS n FROM visit_email WHERE status = 'failed'`)).rows[0].n, 1);
  // limite horaire
  process.env.EMAIL_RATE_PER_HOUR = '2';
  try {
    assert.equal((await mg.call('POST', `/api/mobile/v1/visits/${visit}/email`, { recipient_ids: [down[0]], parts: ['report'] })).status, 429);
  } finally { delete process.env.EMAIL_RATE_PER_HOUR; }
  void a;
  // sans configuration SMTP
  const f2 = await fixture(noMail); const c = await f2.login('c1@x.fr'); const v = uuid();
  await c.push([op('visit', 'create', v, { company_id: f2.f1, status: 'in_progress' })]);
  const o2 = (await c.call('GET', `/api/mobile/v1/visits/${v}/email-options`)).body;
  assert.equal(o2.configured, false);
  const r = await c.call('POST', `/api/mobile/v1/visits/${v}/email`, { recipient_ids: [o2.recipients[0].id], parts: ['notes'] });
  assert.equal(r.status, 503); assert.equal(r.body.code, 'email_unavailable');
});
