import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, createUser, Api, PASSWORD, M, type TestEnv } from './helpers.js';

let env: TestEnv;
before(async () => { env = await setup({ minAppVersion: '1.2.0' }); await createUser(env.pool, 'a@x.fr', 'commercial'); });
after(async () => { await env.close(); });

test('connexion refusée avec un mot de passe incorrect, puis verrouillage après 5 échecs', async () => {
  const api = new Api(env.base, '1.2.0');
  for (let i = 0; i < 5; i++) assert.equal((await api.login('a@x.fr', 'mauvais')).status, 401);
  const r = await api.login('a@x.fr', PASSWORD);
  assert.equal(r.status, 423);
  assert.equal(r.body.code, 'account_locked');
  await env.pool.query(`UPDATE app_user SET locked_until = NULL, failed_logins = 0`);
});

test('application trop ancienne : 426 upgrade_required', async () => {
  const r = await new Api(env.base, '1.0.0').login('a@x.fr');
  assert.equal(r.status, 426);
  assert.equal(r.body.code, 'upgrade_required');
});

test('requête sans jeton : 401', async () => {
  const r = await new Api(env.base, '1.2.0').call('GET', `${M}/me`);
  assert.equal(r.status, 401);
});

test('rotation du jeton de renouvellement ; la réutilisation d\'un ancien jeton coupe la session', async () => {
  const api = new Api(env.base, '1.2.0');
  assert.equal((await api.login('a@x.fr')).status, 200);
  const first = api.refresh;
  const r1 = await api.call('POST', `${M}/auth/refresh`, { refresh_token: first });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.body.refresh_token, first);
  // l'ancien jeton est rejoué (vol présumé) : refus et session de l'appareil révoquée
  const r2 = await api.call('POST', `${M}/auth/refresh`, { refresh_token: first });
  assert.equal(r2.status, 401);
  const r3 = await api.call('POST', `${M}/auth/refresh`, { refresh_token: r1.body.refresh_token });
  assert.equal(r3.status, 401);
  // le jeton d'accès de cet appareil ne fonctionne plus non plus
  api.token = r1.body.access_token;
  assert.equal((await api.call('GET', `${M}/me`)).status, 401);
});

test('déconnexion : le jeton d\'accès cesse de fonctionner', async () => {
  const api = new Api(env.base, '1.2.0');
  await api.login('a@x.fr');
  assert.equal((await api.call('GET', `${M}/me`)).status, 200);
  assert.equal((await api.call('POST', `${M}/auth/logout`)).status, 204);
  assert.equal((await api.call('GET', `${M}/me`)).status, 401);
});
