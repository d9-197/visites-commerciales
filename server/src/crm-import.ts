import type { Pool } from './db.js';
import { tx } from './db.js';
import { withRevocations } from './sync/revocations.js';

/** Ce que le CRM envoie (société, adresse, secteur, contacts, commerciaux responsables). Format à confirmer avec l'équipe CRM. */
export interface CrmCompany {
  crm_id: string; name: string; address_line?: string; postal_code?: string; city?: string; country?: string; sector?: string;
  contacts: { crm_id: string; full_name: string; job_title?: string; phone?: string; email?: string }[];
  sales_emails: string[];
}

/**
 * Import incrémental : insère ou met à jour les clients et contacts, aligne les affectations sur les commerciaux du CRM,
 * marque inactif un client absent de la liste complète (`fullList`) au lieu de le supprimer.
 */
export async function importCrm(pool: Pool, companies: CrmCompany[], opts: { fullList?: boolean } = {}) {
  return tx(pool, c => withRevocations(c, async () => {
    const stats = { companies: 0, contacts: 0, assignments: 0, deactivated: 0 };
    for (const co of companies) {
      const row = (await c.query(
        `INSERT INTO company(crm_id, name, address_line, postal_code, city, country, sector, status, inactive_since, crm_synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',NULL, now())
         ON CONFLICT (crm_id) DO UPDATE SET name=$2, address_line=$3, postal_code=$4, city=$5, country=$6, sector=$7,
           status='active', inactive_since=NULL, crm_synced_at=now() RETURNING id`,
        [co.crm_id, co.name, co.address_line ?? null, co.postal_code ?? null, co.city ?? null, co.country ?? null, co.sector ?? null])).rows[0];
      stats.companies++;
      for (const ct of co.contacts) {
        await c.query(
          `INSERT INTO contact(crm_id, company_id, full_name, job_title, phone, email) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (crm_id) DO UPDATE SET company_id=$2, full_name=$3, job_title=$4, phone=$5, email=$6`,
          [ct.crm_id, row.id, ct.full_name, ct.job_title ?? null, ct.phone ?? null, ct.email ?? null]);
        stats.contacts++;
      }
      const users = (await c.query(`SELECT id FROM app_user WHERE email = ANY($1::citext[])`, [co.sales_emails])).rows.map(r => r.id);
      const removed = await c.query(`UPDATE company_assignment SET removed_at = now() WHERE company_id = $1 AND source = 'crm' AND removed_at IS NULL AND NOT (user_id = ANY($2::uuid[]))`, [row.id, users]);
      stats.assignments += removed.rowCount ?? 0;
      for (const uid of users) {
        const r = await c.query(
          `INSERT INTO company_assignment(company_id, user_id, source) VALUES ($1,$2,'crm')
           ON CONFLICT (company_id, user_id) DO UPDATE SET removed_at = NULL WHERE company_assignment.removed_at IS NOT NULL RETURNING 1`, [row.id, uid]);
        stats.assignments += r.rowCount ?? 0;
      }
    }
    if (opts.fullList) {
      const r = await c.query(`UPDATE company SET status='inactive', inactive_since=now() WHERE status='active' AND NOT (crm_id = ANY($1::text[]))`, [companies.map(x => x.crm_id)]);
      stats.deactivated = r.rowCount ?? 0;
    }
    return stats;
  }));
}
