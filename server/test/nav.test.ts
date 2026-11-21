import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyAddress, detectEnv, navigationOptions } from '../../mobile/src/nav.js';
import { dateToStr, fmtDate, strToDate } from '../../mobile/src/dates.js';

test('adresse du client sur une ligne, champs manquants ignorés', () => {
  assert.equal(companyAddress({ address_line: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country: 'France' }), '12 rue des Lilas, 69003 Lyon, France');
  assert.equal(companyAddress({ city: 'Grenoble' }), 'Grenoble');
  assert.equal(companyAddress({}), '');
  assert.equal(companyAddress(undefined), '');
});

test('détection de la plateforme : native ou navigateur', () => {
  assert.equal(detectEnv('ios'), 'ios');
  assert.equal(detectEnv('android'), 'android');
  assert.equal(detectEnv('web', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(detectEnv('web', 'Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
  assert.equal(detectEnv('web', 'Mozilla/5.0 (X11; Linux x86_64)'), 'other');
});

test('applications d\'itinéraire proposées selon la plateforme, adresse correctement encodée', () => {
  const addr = '12 rue des Lilas, 69003 Lyon';
  const ids = (e: 'ios' | 'android' | 'other') => navigationOptions(addr, e).map(o => o.id);
  assert.deepEqual(ids('ios'), ['apple', 'google', 'waze']);
  assert.deepEqual(ids('android'), ['google', 'waze', 'system']);
  assert.deepEqual(ids('other'), ['apple', 'google', 'waze']);
  const g = navigationOptions(addr, 'android').find(o => o.id === 'google')!.url;
  assert.equal(g, 'https://www.google.com/maps/dir/?api=1&destination=12%20rue%20des%20Lilas%2C%2069003%20Lyon');
  assert.equal(navigationOptions(addr, 'android').find(o => o.id === 'system')!.url, 'geo:0,0?q=12%20rue%20des%20Lilas%2C%2069003%20Lyon');
  assert.ok(navigationOptions('Rue de l\'Église & Cie', 'ios').every(o => !o.url.includes('&Cie') && !o.url.includes(' ')), 'caractères spéciaux encodés');
});

test('dates seules : aucun décalage d\'un jour, affichage lisible', () => {
  assert.equal(dateToStr(strToDate('2026-11-26')!), '2026-11-26');
  assert.equal(dateToStr(strToDate('2026-01-01')!), '2026-01-01');
  assert.match(fmtDate('2026-11-26'), /26 nov\.? 2026/);
  assert.equal(fmtDate(null), '');
  assert.equal(strToDate('26/11/2026'), undefined);
});
