import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setup, fixture, op, uuid, M, type TestEnv, type Fixture } from './helpers.js';
import { VoxtralService } from '../src/ai/voxtral.js';
import { MistralService } from '../src/ai/mistral.js';

// Faux serveur de transcription : analyse le formulaire multipart reçu et renvoie la réponse programmée. Aucun appel réel à Mistral.
interface Part { name: string; filename?: string; type?: string; size: number; text: string }
interface Seen { path: string; auth?: string; contentType?: string; parts: Part[] }
function parseMultipart(buf: Buffer, contentType: string): Part[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) return [];
  const raw = buf.toString('latin1');
  return raw.split(`--${boundary}`).slice(1, -1).map(chunk => {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    const data = rest.join('\r\n\r\n').replace(/\r\n$/, '');
    return {
      name: /name="([^"]+)"/.exec(head!)?.[1] ?? '', filename: /filename="([^"]*)"/.exec(head!)?.[1],
      type: /content-type:\s*([^\r\n]+)/i.exec(head!)?.[1], size: Buffer.byteLength(data, 'latin1'), text: Buffer.from(data, 'latin1').toString('utf8'),
    };
  });
}
async function fakeVoxtral() {
  let next: { status: number; json: unknown } = { status: 200, json: {} };
  const seen: Seen[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, contentType: req.headers['content-type'], parts: parseMultipart(Buffer.concat(chunks), req.headers['content-type'] ?? '') });
      res.writeHead(next.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(next.json));
    });
  }).listen(0);
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, reply: (status: number, json: unknown) => { next = { status, json }; }, close: () => new Promise<void>(r => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

let env: TestEnv; let f: Fixture; let fake: Awaited<ReturnType<typeof fakeVoxtral>>; let visit: string;
const cfg = () => ({ apiKey: 'cle-de-test', baseUrl: fake.url, model: 'm', timeoutMs: 2000, transcribeModel: 'voxtral-test', transcribeTimeoutMs: 2000, priceInEurPerM: 1, priceOutEurPerM: 3, priceTranscribeEurPerMin: 0.3 });
const AUDIO = Buffer.concat([Buffer.from('OggS-test-audio-'), Buffer.alloc(2000, 7)]);
const OK = { model: 'voxtral-test', text: '  Alors monsieur Martin est intéressé, budget de quarante mille euros.  ', language: 'fr', usage: { prompt_audio_seconds: 42 } };

before(async () => {
  fake = await fakeVoxtral();
  env = await setup({}, { ai: { service: new MistralService(cfg()), transcriber: new VoxtralService(cfg()), prices: true, transcribePrice: 0.3 } });
  f = await fixture(env);
  const a = await f.login('c1@x.fr'); visit = uuid();
  await a.push([op('visit', 'create', visit, { company_id: f.f1 })]);
});
after(async () => { await env.close(); await fake.close(); });

const send = async (who = 'c1@x.fr', body: Buffer | string = AUDIO, ct = 'audio/webm;codecs=opus', qs = 'language=fr&duration_s=45', id = visit) => {
  const a = await f.login(who);
  const res = await fetch(`${env.base}${M}/visits/${id}/transcriptions?${qs}`, { method: 'POST', headers: { 'content-type': ct, authorization: `Bearer ${a.token}`, 'x-app-version': '1.0.0' }, body: body as any });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

test('voix : l\'audio est transmis à Voxtral au format documenté (multipart : modèle, fichier, langue) et le texte est renvoyé', async () => {
  fake.reply(200, OK);
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(r.body.text, 'Alors monsieur Martin est intéressé, budget de quarante mille euros.', 'texte nettoyé des espaces');
  assert.equal(r.body.language, 'fr'); assert.equal(r.body.duration_s, 42, 'durée annoncée par le fournisseur');

  const s = fake.seen.at(-1)!;
  assert.equal(s.path, '/v1/audio/transcriptions'); assert.equal(s.auth, 'Bearer cle-de-test');
  assert.match(s.contentType ?? '', /^multipart\/form-data; boundary=/);
  const part = (n: string) => s.parts.find(p => p.name === n)!;
  assert.equal(part('model').text, 'voxtral-test'); assert.equal(part('language').text, 'fr');
  assert.equal(part('file').size, AUDIO.length, 'l\'audio arrive en entier'); assert.equal(part('file').type, 'audio/webm'); assert.equal(part('file').filename, 'dictee.webm');
  assert.ok(!JSON.stringify(s.parts.map(p => p.text.slice(0, 40))).includes('Dupont'), 'aucune donnée de client envoyée');
});

test('voix : sans langue, détection automatique (le champ n\'est pas envoyé) ; formats m4a et mp3', async () => {
  fake.reply(200, { ...OK, language: 'nl' });
  const r = await send('c1@x.fr', AUDIO, 'audio/mp4', '');
  assert.equal(r.status, 200); assert.equal(r.body.language, 'nl');
  const s = fake.seen.at(-1)!;
  assert.equal(s.parts.some(p => p.name === 'language'), false);
  assert.equal(s.parts.find(p => p.name === 'file')!.filename, 'dictee.m4a');
  await send('c1@x.fr', AUDIO, 'audio/mpeg', 'language=fr');
  assert.equal(fake.seen.at(-1)!.parts.find(p => p.name === 'file')!.filename, 'dictee.mp3');
});

test('voix : usage enregistré (durée et coût, au tarif par minute) ; ni l\'audio ni le texte ne sont conservés', async () => {
  fake.reply(200, OK);
  await env.pool.query(`DELETE FROM ai_usage`);
  assert.equal((await send()).status, 200);
  const u = (await env.pool.query(`SELECT kind, provider, audio_seconds, cost_cents FROM ai_usage`)).rows;
  assert.equal(u.length, 1); assert.equal(u[0].kind, 'transcription'); assert.equal(u[0].provider, 'mistral-voxtral');
  assert.equal(Number(u[0].audio_seconds), 42);
  assert.ok(Math.abs(Number(u[0].cost_cents) - (42 / 60) * 0.3 * 100) < 1e-6, '42 s à 0,30 €/min');
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM recording`)).rows[0].n, 0, 'aucun enregistrement conservé');
  assert.equal((await env.pool.query(`SELECT count(*)::int n FROM transcription`)).rows[0].n, 0, 'aucun texte conservé côté serveur');
});

test('voix : sans durée du fournisseur, la durée annoncée par l\'application est utilisée', async () => {
  fake.reply(200, { text: 'ok', language: 'fr' });
  await env.pool.query(`DELETE FROM ai_usage`);
  const r = await send('c1@x.fr', AUDIO, 'audio/webm', 'language=fr&duration_s=90');
  assert.equal(r.body.duration_s, 90);
  assert.equal(Number((await env.pool.query(`SELECT audio_seconds FROM ai_usage`)).rows[0].audio_seconds), 90);
});

test('voix : réponse illisible, sans texte, erreur du fournisseur : 502 neutre', async () => {
  for (const reply of [[200, { model: 'x' }], [200, 'pas du json'], [415, { message: 'format secret' }], [500, {}]] as const) {
    fake.reply(reply[0], reply[1]);
    const r = await send();
    assert.equal(r.status, 502); assert.equal(r.body.code, 'ai_failed');
    assert.ok(!JSON.stringify(r.body).includes('format secret'), 'le message du fournisseur n\'est pas relayé');
  }
});

test('voix : entrées invalides : corps vide, type non audio, langue inconnue, durée absurde, trop volumineux', async () => {
  fake.reply(200, OK);
  assert.equal((await send('c1@x.fr', Buffer.alloc(10))).status, 400, 'trop court');
  assert.equal((await send('c1@x.fr', JSON.stringify({ a: 1 }).repeat(50), 'application/json')).status, 400, 'pas de l\'audio');
  assert.equal((await send('c1@x.fr', AUDIO, 'audio/webm', 'language=xx')).status, 400);
  assert.equal((await send('c1@x.fr', AUDIO, 'audio/webm', 'duration_s=99999')).status, 400);
  const prev = process.env.AUDIO_MAX_BYTES;   // la limite est lue à la création du routeur : on teste avec un second serveur
  void prev;
  process.env.AUDIO_MAX_BYTES = '5000';
  try {
    const e3 = await setup({}, { ai: { service: new MistralService(cfg()), transcriber: new VoxtralService(cfg()), prices: false, transcribePrice: undefined } });
    const fx = await fixture(e3); const a = await fx.login('c1@x.fr'); const v = uuid();
    await a.push([op('visit', 'create', v, { company_id: fx.f1 })]);
    const res = await fetch(`${e3.base}${M}/visits/${v}/transcriptions`, { method: 'POST', headers: { 'content-type': 'audio/webm', authorization: `Bearer ${a.token}`, 'x-app-version': '1.0.0' }, body: Buffer.alloc(6000, 1) });
    assert.equal(res.status, 413); assert.equal((await res.json()).code, 'payload_too_large');
    await e3.close();
  } finally { if (prev === undefined) delete process.env.AUDIO_MAX_BYTES; else process.env.AUDIO_MAX_BYTES = prev; }
});

test('voix : droits : auteur seul, inconnue pour qui ne voit pas la visite, 401 sans connexion, 404 visite inconnue', async () => {
  fake.reply(200, OK);
  assert.equal((await send('mgr1@x.fr')).status, 403);
  assert.equal((await send('c3@x.fr')).status, 404);
  assert.equal((await send('c1@x.fr', AUDIO, 'audio/webm', '', uuid())).status, 404);
  const res = await fetch(`${env.base}${M}/visits/${visit}/transcriptions`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: AUDIO });
  assert.equal(res.status, 401);
});

test('voix : plafond mensuel commun à la transcription et à la synthèse ; limitation de débit', async () => {
  fake.reply(200, OK);
  process.env.AI_RATE_PER_MIN = '1000';
  await env.pool.query(`UPDATE app_user SET ai_budget_cents = 0.0001 WHERE id = $1`, [f.c1]);
  await env.pool.query(`INSERT INTO ai_usage(user_id, kind, provider, model, cost_cents) VALUES ($1,'llm','mistral','m',5)`, [f.c1]);
  const r = await send();
  assert.equal(r.status, 402); assert.equal(r.body.code, 'quota_exceeded');
  await env.pool.query(`UPDATE app_user SET ai_budget_cents = NULL WHERE id = $1`, [f.c1]);
  await env.pool.query(`DELETE FROM ai_usage`);
  process.env.AI_RATE_PER_MIN = '3';
  let last = 0;
  for (let i = 0; i < 5; i++) last = (await send('c1@x.fr')).status;
  assert.equal(last, 429);
  delete process.env.AI_RATE_PER_MIN;
});

test('voix : sans clé configurée : 503 ; fournisseur qui ne répond pas : 502 sans bloquer', async () => {
  const e2 = await setup({}, {});
  try {
    const fx = await fixture(e2); const a = await fx.login('c1@x.fr'); const v = uuid();
    await a.push([op('visit', 'create', v, { company_id: fx.f1 })]);
    const res = await fetch(`${e2.base}${M}/visits/${v}/transcriptions`, { method: 'POST', headers: { 'content-type': 'audio/webm', authorization: `Bearer ${a.token}`, 'x-app-version': '1.0.0' }, body: AUDIO });
    assert.equal(res.status, 503); assert.equal((await res.json()).code, 'ai_unavailable');
  } finally { await e2.close(); }
  const slow = http.createServer(() => {}).listen(0);
  const t0 = Date.now();
  const s = new VoxtralService({ ...cfg(), baseUrl: `http://127.0.0.1:${(slow.address() as AddressInfo).port}`, transcribeTimeoutMs: 150 });
  await assert.rejects(s.transcribe({ audio: AUDIO, mime: 'audio/webm' }), /injoignable/);
  assert.ok(Date.now() - t0 < 2000);
  slow.closeAllConnections(); slow.close();
});
