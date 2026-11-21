import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, type TestEnv } from './helpers.js';
import { brandFromEnv, cleanBrandName, DEFAULT_BRAND_NAME } from '../src/brand.js';
import { renderIndex } from '../src/app.js';
import { composeVisitEmail } from '../src/mail/compose.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dir = mkdtempSync(join(tmpdir(), 'brand-'));
const file = (name: string, data: Buffer | string) => { const p = join(dir, name); writeFileSync(p, data); return p; };

test('marque : nom nettoyé, défaut si vide ; logo png/svg chargé ; fichier absent, trop lourd ou de format inattendu ignoré (le nom reste)', () => {
  assert.equal(cleanBrandName(undefined), DEFAULT_BRAND_NAME);
  assert.equal(cleanBrandName('  <b>ACME</b>\n\tSA  '), 'b ACME /b SA');
  assert.equal(cleanBrandName('x'.repeat(100)).length, 60);
  const warns: string[] = []; const warn = (m: string) => warns.push(m);
  const ok = brandFromEnv({ BRAND_NAME: 'ACME', BRAND_LOGO_FILE: file('logo.png', PNG) }, warn);
  assert.equal(ok.name, 'ACME'); assert.equal(ok.logo?.mime, 'image/png'); assert.equal(ok.logo?.data.length, PNG.length); assert.equal(ok.logo?.version.length, 12);
  assert.equal(brandFromEnv({ BRAND_LOGO_FILE: file('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>') }, warn).logo?.mime, 'image/svg+xml');
  for (const env of [{ BRAND_LOGO_FILE: join(dir, 'absent.png') }, { BRAND_LOGO_FILE: file('gros.png', Buffer.alloc(600 * 1024)) }, { BRAND_LOGO_FILE: file('x.exe', 'MZ') }]) {
    const b = brandFromEnv({ BRAND_NAME: 'ACME', ...env }, warn);
    assert.equal(b.logo, undefined); assert.equal(b.name, 'ACME');
  }
  assert.equal(warns.length, 3);
  assert.equal(brandFromEnv({}, warn).logo, undefined);
});

let env: TestEnv; let plain: TestEnv;
before(async () => {
  env = await setup({}, { brand: { name: 'ACME "Industrie"', logo: { data: PNG, mime: 'image/png', version: 'abc123def456' } } });
  plain = await setup();
});
after(async () => { await env.close(); await plain.close(); });

test('marque : API publique (sans authentification) ; logo servi avec le bon type ; défaut sans configuration', async () => {
  const r = await fetch(`${env.base}/api/mobile/v1/brand`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'ACME "Industrie"', logo_path: '/brand/logo?v=abc123def456' });
  const l = await fetch(`${env.base}/api/mobile/v1/brand/logo?v=abc123def456`);
  assert.equal(l.status, 200); assert.equal(l.headers.get('content-type'), 'image/png'); assert.equal(l.headers.get('x-content-type-options'), 'nosniff');
  assert.match(l.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(Buffer.from(await l.arrayBuffer()), PNG);
  const d = await (await fetch(`${plain.base}/api/mobile/v1/brand`)).json();
  assert.deepEqual(d, { name: DEFAULT_BRAND_NAME, logo_path: null });
  assert.equal((await fetch(`${plain.base}/api/mobile/v1/brand/logo`)).status, 404);
});

test('marque : titre et icône de la page web (nom échappé, sous-chemin respecté) ; inchangé sans marque', () => {
  const INDEX = '<html><head><title>Visites commerciales</title><script src="/_expo/a.js"></script></head><body></body></html>';
  const brand = { name: 'ACME "Industrie" & Fils', logo: { data: PNG, mime: 'image/png', version: 'v1' } };
  const out = renderIndex(INDEX, '/visit', brand);
  assert.ok(out.includes('<title>ACME &quot;Industrie&quot; &amp; Fils</title>'));
  assert.ok(out.includes('<link rel="icon" href="/visit/api/mobile/v1/brand/logo?v=v1">'));
  assert.ok(out.includes('src="/visit/_expo/a.js"'));
  assert.equal(renderIndex(INDEX, '', { name: DEFAULT_BRAND_NAME }), INDEX);
});

test('marque : e-mail signé du nom de l\'entreprise (échappé)', () => {
  const m = composeVisitEmail({ company: 'Dupont', plannedStart: null, startedAt: null, endedAt: null, location: null, senderName: 'Jeanne', brandName: 'ACME <Fils>' });
  assert.ok(m.text.includes('Envoyé depuis ACME <Fils>.') && m.html.includes('Envoyé depuis ACME &lt;Fils&gt;.'));
  assert.ok(composeVisitEmail({ company: 'D', plannedStart: null, startedAt: null, endedAt: null, location: null, senderName: 'J' }).text.includes('Envoyé depuis Visites commerciales.'));
});
