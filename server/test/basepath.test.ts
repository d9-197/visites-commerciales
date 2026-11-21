import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, type TestEnv } from './helpers.js';
import { normalizeBasePath, renderIndex } from '../src/app.js';

const INDEX = `<!DOCTYPE html><html><head><title>t</title><link rel="icon" href="/favicon.ico" /></head><body><div id="root"></div><script src="/_expo/static/js/web/index-abc.js" defer></script></body></html>`;
let dir: string; let env: TestEnv; let envRoot: TestEnv;
const get = async (e: TestEnv, path: string) => { const r = await fetch(e.base + path); return { status: r.status, type: r.headers.get('content-type') ?? '', text: await r.text() }; };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  mkdirSync(join(dir, '_expo/static/js/web'), { recursive: true });
  writeFileSync(join(dir, '_expo/static/js/web/index-abc.js'), 'console.log("app")');
  env = await setup({}, { webDir: dir, basePath: '/visit' });
  envRoot = await setup({}, { webDir: dir });
});
after(async () => { await env.close(); await envRoot.close(); rmSync(dir, { recursive: true, force: true }); });

test('BASE_PATH : normalisation et refus des valeurs dangereuses', () => {
  assert.equal(normalizeBasePath(''), ''); assert.equal(normalizeBasePath(undefined), '');
  assert.equal(normalizeBasePath('visit'), '/visit'); assert.equal(normalizeBasePath('/visit/'), '/visit'); assert.equal(normalizeBasePath(' /a/b-c '), '/a/b-c');
  for (const bad of ['/vi sit', '//evil.com', '/a/../b', '/a?b', '/"><script>']) assert.throws(() => normalizeBasePath(bad), /invalide/, bad);
});

test('page d\'accueil : sans préfixe, inchangée ; avec préfixe, ressources préfixées et préfixe transmis à l\'application', () => {
  assert.equal(renderIndex(INDEX, ''), INDEX);
  const out = renderIndex(INDEX, '/visit');
  assert.ok(out.includes('src="/visit/_expo/static/js/web/index-abc.js"') && out.includes('href="/visit/favicon.ico"'));
  assert.ok(out.includes('window.__BASE_PATH__="/visit"'));
  assert.ok(!out.includes('src="/_expo'), 'plus aucun chemin absolu vers la racine');
});

test('sous-chemin, proxy qui CONSERVE le préfixe : page, script et API répondent sous /visit', async () => {
  const page = await get(env, '/visit');
  assert.equal(page.status, 200); assert.match(page.type, /html/); assert.ok(page.text.includes('src="/visit/_expo/static/js/web/index-abc.js"'));
  assert.equal((await get(env, '/visit/')).status, 200);
  const js = await get(env, '/visit/_expo/static/js/web/index-abc.js');
  assert.equal(js.status, 200); assert.match(js.type, /javascript/); assert.equal(js.text, 'console.log("app")');
  const api = await get(env, '/visit/api/mobile/v1/me');
  assert.equal(api.status, 401); assert.match(api.type, /problem\+json/, 'l\'API répond en JSON, pas la page');
  const unknown = await get(env, '/visit/api/inconnu');
  assert.equal(unknown.status, 404); assert.match(unknown.type, /problem\+json/);
});

test('sous-chemin, proxy qui RETIRE le préfixe : mêmes réponses à la racine', async () => {
  const page = await get(env, '/');
  assert.equal(page.status, 200); assert.ok(page.text.includes('src="/visit/_expo/'), 'le navigateur redemandera /visit/_expo/…, que le proxy ramènera à /_expo/…');
  assert.equal((await get(env, '/_expo/static/js/web/index-abc.js')).status, 200);
  assert.equal((await get(env, '/api/mobile/v1/me')).status, 401);
});

test('application à la racine : comportement inchangé', async () => {
  const page = await get(envRoot, '/');
  assert.equal(page.status, 200); assert.ok(page.text.includes('src="/_expo/static/js/web/index-abc.js"') && !page.text.includes('__BASE_PATH__'));
  assert.equal((await get(envRoot, '/visit')).status, 200, 'toute adresse inconnue hors /api renvoie la page (application à une seule page)');
  assert.equal((await get(envRoot, '/api/inconnu')).status, 404);
});
