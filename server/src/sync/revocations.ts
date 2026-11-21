import type { Client } from '../db.js';

type Snapshot = Map<string, { company: Set<string>; visit: Set<string>; action: Set<string> }>;

async function snapshot(c: Client): Promise<Snapshot> {
  const users = (await c.query(`SELECT id FROM app_user WHERE status = 'active'`)).rows;
  const snap: Snapshot = new Map();
  for (const u of users) {
    const [co, vi, ac] = await Promise.all([
      c.query(`SELECT id FROM company WHERE can_read_company($1, id)`, [u.id]),
      c.query(`SELECT id FROM visit WHERE can_read_visit($1, id)`, [u.id]),
      c.query(`SELECT id FROM action_item WHERE can_read_action($1, id)`, [u.id]),
    ]);
    snap.set(u.id, {
      company: new Set(co.rows.map(r => r.id)), visit: new Set(vi.rows.map(r => r.id)), action: new Set(ac.rows.map(r => r.id)),
    });
  }
  return snap;
}

/**
 * Exécute un changement susceptible de réduire ce que des utilisateurs voient (affectation retirée, mode de visibilité,
 * hiérarchie) et enregistre, pour chacun, les données devenues invisibles. L'appareil les supprime à la synchro suivante.
 * Prototype : calcul complet avant/après, en ligne. En production, à confier à une tâche en arrière-plan.
 */
export async function withRevocations<T>(c: Client, change: () => Promise<T>): Promise<{ result: T; revoked: number }> {
  const before = await snapshot(c);
  const result = await change();
  const after = await snapshot(c);
  let revoked = 0;
  for (const [uid, b] of before) {
    const a = after.get(uid);
    if (!a) continue;
    for (const entity of ['company', 'visit', 'action'] as const) {
      for (const id of b[entity]) {
        if (!a[entity].has(id)) {
          await c.query(`INSERT INTO access_revocation(user_id, entity, entity_id) VALUES ($1,$2,$3)`, [uid, entity, id]);
          revoked++;
        }
      }
    }
  }
  return { result, revoked };
}

/** Nombre de visites qui deviendraient visibles / invisibles si le mode passait à `mode` (sans rien modifier). */
export async function previewModeImpact(c: Client, mode: 1 | 2) {
  await c.query('BEGIN');
  try {
    const before = await snapshot(c);
    await c.query(`UPDATE app_setting SET value = to_jsonb($1::text) WHERE key = 'report_visibility_mode'`, [String(mode)]);
    const after = await snapshot(c);
    let becomingVisible = 0, becomingHidden = 0;
    for (const [uid, b] of before) {
      const a = after.get(uid)!;
      for (const id of a.visit) if (!b.visit.has(id)) becomingVisible++;
      for (const id of b.visit) if (!a.visit.has(id)) becomingHidden++;
    }
    return { becomingVisible, becomingHidden };
  } finally {
    await c.query('ROLLBACK');
  }
}
