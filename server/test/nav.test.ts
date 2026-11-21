import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyAddress, detectEnv, navigationOptions } from '../../mobile/src/nav.js';
import { dateToStr, fmtDate, strToDate } from '../../mobile/src/dates.js';
import { isActionLate, isVisitLate, canEditVisitAddress, canEditVisitDate, canTransition } from '@visites/sync-core';

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

test('retard : visite non commencée dont l\'heure est dépassée de plus d\'une heure ; action à faire dont l\'échéance est passée', () => {
  const now = new Date('2026-11-21T12:00:00Z');
  assert.equal(isVisitLate({ status: 'planned', planned_start: '2026-11-21T10:30:00Z' }, now), true);
  assert.equal(isVisitLate({ status: 'organized', planned_start: '2026-11-20T09:00:00Z' }, now), true);
  assert.equal(isVisitLate({ status: 'planned', planned_start: '2026-11-21T11:30:00Z' }, now), false, 'moins d\'une heure de retard : marge');
  assert.equal(isVisitLate({ status: 'planned', planned_start: '2026-11-22T09:00:00Z' }, now), false, 'à venir');
  assert.equal(isVisitLate({ status: 'in_progress', planned_start: '2026-11-01T09:00:00Z' }, now), false, 'commencée');
  assert.equal(isVisitLate({ status: 'done', planned_start: '2026-11-01T09:00:00Z' }, now), false);
  assert.equal(isVisitLate({ status: 'planned' }, now), false, 'sans date prévue');
  assert.equal(isActionLate({ status: 'todo', due_date: '2026-11-20' }, '2026-11-21'), true);
  assert.equal(isActionLate({ status: 'todo', due_date: '2026-11-21' }, '2026-11-21'), false, 'échéance aujourd\'hui : pas en retard');
  assert.equal(isActionLate({ status: 'done', due_date: '2026-11-01' }, '2026-11-21'), false);
  assert.equal(isActionLate({ status: 'cancelled', due_date: '2026-11-01' }, '2026-11-21'), false);
  assert.equal(isActionLate({ status: 'todo', due_date: null }, '2026-11-21'), false);
});

test('règles partagées : adresse, date, transitions', () => {
  assert.equal(canEditVisitAddress('planned', 'directeur'), true);
  assert.equal(canEditVisitAddress('organized', 'manager'), false);
  assert.equal(canEditVisitAddress('organized', 'commercial'), true);
  assert.equal(canEditVisitAddress('in_progress', 'commercial'), false);
  assert.equal(canEditVisitDate('planned', true), true);
  assert.equal(canEditVisitDate('planned', false), false);
  assert.equal(canEditVisitDate('in_progress', true), false);
  assert.equal(canTransition('planned', 'organized'), true);
  assert.equal(canTransition('done', 'planned'), false);
});
