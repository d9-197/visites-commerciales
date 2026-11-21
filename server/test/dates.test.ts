import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromLocalInputs, toLocalInputs, visitWhen } from '../../mobile/src/dates.js';

test('dates : aller-retour entre saisie locale et horodatage ISO', () => {
  const iso = fromLocalInputs('2026-12-01', '14:30')!;
  assert.ok(iso.endsWith('Z'));
  assert.deepEqual(toLocalInputs(iso), { date: '2026-12-01', time: '14:30' });
});

test('dates : saisies invalides refusées (format, heure, jour inexistant)', () => {
  assert.equal(fromLocalInputs('01/12/2026', '14:30'), undefined);
  assert.equal(fromLocalInputs('2026-12-01', '25:00'), undefined);
  assert.equal(fromLocalInputs('2026-02-30', '10:00'), undefined);
  assert.equal(fromLocalInputs('', ''), undefined);
  assert.ok(fromLocalInputs('2026-12-01', ''), 'heure absente : 09:00 par défaut');
});

test('dates : libellés d\'une visite selon son état', () => {
  assert.match(visitWhen({ status: 'planned', planned_start: '2026-12-01T13:30:00Z' }).main, /^Prévue /);
  assert.equal(visitWhen({ status: 'planned' }).main, 'Non planifiée');
  const done = visitWhen({ status: 'done', planned_start: '2026-12-01T13:30:00Z', ended_at: '2026-12-02T09:00:00Z' });
  assert.match(done.main, /^Réalisée /); assert.match(done.sub!, /^Prévue /);
  assert.match(visitWhen({ status: 'in_progress', started_at: '2026-12-01T13:30:00Z' }).main, /^Commencée /);
});
