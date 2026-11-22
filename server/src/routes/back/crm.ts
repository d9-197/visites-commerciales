import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from '../../db.js';
import { tx } from '../../db.js';
import { HttpError, wrap } from '../../errors.js';
import { withRevocations } from '../../sync/revocations.js';
import { importCrm, type CrmCompany } from '../../crm-import.js';
import { parseCsv } from '../../csv.js';
import { requireAdmin, pagination } from './scope.js';

const uuid = z.string().uuid();
const nstr = z.string().trim().max(300).nullable().optional();
const newCrmId = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex').toUpperCase()}`;

/** Maquette du CRM : clients, contacts, affectations, import CSV. Écriture : administrateurs seulement (même tables que l'import du vrai CRM). */
export function crmRouter(pool: Pool) {
  const r = express.Router();

  const assigned = (ids: string[]) => pool.query(
    `SELECT a.company_id, u.id, u.display_name FROM company_assignment a JOIN app_user u ON u.id = a.user_id WHERE a.removed_at IS NULL AND a.company_id = ANY($1::uuid[]) ORDER BY u.display_name`, [ids]);

  r.get('/companies', wrap(async (req, res) => {
    requireAdmin(req);
    const q = String(req.query.q ?? '').trim(); const status = ['active', 'inactive'].includes(String(req.query.status)) ? String(req.query.status) : null;
    const { limit, offset } = pagination(req);
    const where = `($1 = '' OR c.name ILIKE '%'||$1||'%' OR c.crm_id ILIKE '%'||$1||'%' OR c.city ILIKE '%'||$1||'%') AND ($2::text IS NULL OR c.status = $2) AND c.deleted_at IS NULL`;
    const total = (await pool.query(`SELECT count(*)::int AS n FROM company c WHERE ${where}`, [q, status])).rows[0].n;
    const { rows } = await pool.query(
      `SELECT c.id, c.crm_id, c.name, c.address_line, c.postal_code, c.city, c.country, c.sector, c.status,
        (SELECT count(*)::int FROM contact t WHERE t.company_id = c.id AND t.deleted_at IS NULL) AS contacts_count,
        (SELECT count(*)::int FROM visit v WHERE v.company_id = c.id AND v.status <> 'deleted') AS visits_count
       FROM company c WHERE ${where} ORDER BY c.name LIMIT $3 OFFSET $4`, [q, status, limit, offset]);
    const as = rows.length ? (await assigned(rows.map(x => x.id))).rows : [];
    res.json({ total, companies: rows.map(c => ({ ...c, assigned: as.filter(a => a.company_id === c.id).map(a => ({ id: a.id, name: a.display_name })) })) });
  }));

  r.get('/companies/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const c = (await pool.query(`SELECT id, crm_id, name, address_line, postal_code, city, country, sector, status FROM company WHERE id = $1 AND deleted_at IS NULL`, [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'not_found', 'Client inconnu');
    const contacts = (await pool.query(`SELECT id, crm_id, full_name, job_title, phone, email FROM contact WHERE company_id = $1 AND deleted_at IS NULL ORDER BY full_name`, [c.id])).rows;
    res.json({ company: { ...c, assigned: (await assigned([c.id])).rows.map(a => ({ id: a.id, name: a.display_name })) }, contacts });
  }));

  const company = z.object({ name: z.string().trim().min(1).max(200), address_line: nstr, postal_code: nstr, city: nstr, country: nstr, sector: nstr }).strict();

  r.post('/companies', wrap(async (req, res) => {
    requireAdmin(req);
    const b = company.extend({ crm_id: z.string().trim().min(1).max(50).optional(), user_ids: z.array(uuid).max(50).optional() }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const d = b.data;
    const id = await tx(pool, c => withRevocations(c, async () => {
      const row = (await c.query(
        `INSERT INTO company(crm_id, name, address_line, postal_code, city, country, sector, status, crm_synced_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'active', now()) RETURNING id`,
        [d.crm_id ?? newCrmId('MAQ'), d.name, d.address_line ?? null, d.postal_code ?? null, d.city ?? null, d.country ?? null, d.sector ?? null])).rows[0];
      for (const uid of d.user_ids ?? []) await c.query(`INSERT INTO company_assignment(company_id, user_id, source) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING`, [row.id, uid]);
      return row.id as string;
    }).then(x => x.result ?? undefined).catch(e => { throw e; })).catch(e => { if (e.code === '23505') throw new HttpError(409, 'crm_id_taken', 'Identifiant CRM déjà utilisé'); if (e.code === '23503') throw new HttpError(404, 'not_found', 'Utilisateur inconnu'); throw e; });
    res.status(201).json({ id });
  }));

  r.patch('/companies/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const b = company.partial().extend({ status: z.enum(['active', 'inactive']).optional() }).strict().safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const f = b.data; const cols = Object.keys(f) as (keyof typeof f)[];
    if (cols.length === 0) return void res.json({ id: req.params.id });
    const sets = cols.map((k, i) => `${k} = $${i + 2}`);
    if (f.status) sets.push(`inactive_since = ${f.status === 'inactive' ? 'COALESCE(inactive_since, now())' : 'NULL'}`);
    const u = await pool.query(`UPDATE company SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [req.params.id, ...cols.map(k => f[k])]);
    if (!u.rows[0]) throw new HttpError(404, 'not_found', 'Client inconnu');
    res.json({ id: req.params.id });
  }));

  r.put('/companies/:id/assignments', wrap(async (req, res) => {
    requireAdmin(req);
    const b = z.object({ user_ids: z.array(uuid).max(100) }).safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', 'Requête invalide');
    if (!(await pool.query(`SELECT 1 FROM company WHERE id = $1`, [req.params.id])).rows[0]) throw new HttpError(404, 'not_found', 'Client inconnu');
    const out = await tx(pool, c => withRevocations(c, async () => {
      await c.query(`UPDATE company_assignment SET removed_at = now() WHERE company_id = $1 AND removed_at IS NULL AND NOT (user_id = ANY($2::uuid[]))`, [req.params.id, b.data.user_ids]);
      for (const uid of b.data.user_ids) {
        await c.query(`INSERT INTO company_assignment(company_id, user_id, source) VALUES ($1,$2,'admin') ON CONFLICT (company_id, user_id) DO UPDATE SET removed_at = NULL, source = 'admin'`, [req.params.id, uid]);
      }
    })).catch(e => { if (e.code === '23503') throw new HttpError(404, 'not_found', 'Utilisateur inconnu'); throw e; });
    res.json({ company_id: req.params.id, revoked: out.revoked });
  }));

  const contact = z.object({ full_name: z.string().trim().min(1).max(200), job_title: nstr, phone: nstr, email: z.string().trim().email().nullable().optional() }).strict();

  r.post('/companies/:id/contacts', wrap(async (req, res) => {
    requireAdmin(req);
    const b = contact.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const d = b.data;
    if (!(await pool.query(`SELECT 1 FROM company WHERE id = $1 AND deleted_at IS NULL`, [req.params.id])).rows[0]) throw new HttpError(404, 'not_found', 'Client inconnu');
    const row = (await pool.query(`INSERT INTO contact(crm_id, company_id, full_name, job_title, phone, email) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [newCrmId('CT'), req.params.id, d.full_name, d.job_title ?? null, d.phone ?? null, d.email ?? null])).rows[0];
    res.status(201).json({ id: row.id });
  }));

  r.patch('/contacts/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const b = contact.partial().safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'validation_failed', b.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const f = b.data; const cols = Object.keys(f) as (keyof typeof f)[];
    if (cols.length) {
      const u = await pool.query(`UPDATE contact SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [req.params.id, ...cols.map(k => f[k])]);
      if (!u.rows[0]) throw new HttpError(404, 'not_found', 'Contact inconnu');
    }
    res.json({ id: req.params.id });
  }));

  r.delete('/contacts/:id', wrap(async (req, res) => {
    requireAdmin(req);
    const u = await pool.query(`UPDATE contact SET deleted_at = now(), active = false WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [req.params.id]);   // suppression logique : visible de la synchro
    if (!u.rows[0]) throw new HttpError(404, 'not_found', 'Contact inconnu');
    res.json({ id: req.params.id });
  }));

  /**
   * Import CSV (même sémantique que l'import du CRM). Clients : crm_id;name;address_line;postal_code;city;country;sector;sales_emails
   * (sales_emails : adresses des commerciaux séparées par espace, virgule, point-virgule ou barre). Contacts : company_crm_id;crm_id;full_name;job_title;phone;email.
   * Les erreurs de format bloquent tout l'import ; une adresse de commercial inconnue n'est qu'un avertissement. `dry_run` : vérifie sans écrire.
   */
  r.post('/import', wrap(async (req, res) => {
    requireAdmin(req);
    const b = z.object({ companies_csv: z.string().max(5_000_000).optional(), contacts_csv: z.string().max(5_000_000).optional(), dry_run: z.boolean().optional() }).safeParse(req.body);
    if (!b.success || (!b.data.companies_csv && !b.data.contacts_csv)) throw new HttpError(400, 'validation_failed', 'Fournir companies_csv et/ou contacts_csv');
    const errors: { file: string; line: number; message: string }[] = []; const warnings: string[] = [];
    const map = new Map<string, CrmCompany>();
    const emails = new Set((await pool.query(`SELECT lower(email::text) AS e FROM app_user`)).rows.map(x => x.e as string));
    const existingCompanies = new Map((await pool.query(`SELECT crm_id, name, address_line, postal_code, city, country, sector FROM company WHERE deleted_at IS NULL`)).rows.map(x => [x.crm_id as string, x]));

    if (b.data.companies_csv) {
      const p = parseCsv(b.data.companies_csv);
      for (const h of ['crm_id', 'name']) if (!p.header.includes(h)) errors.push({ file: 'clients', line: 1, message: `Colonne « ${h} » absente` });
      if (!errors.length) for (const { line, cells: c } of p.rows) {
        if (!c.crm_id || !c.name) { errors.push({ file: 'clients', line, message: 'crm_id et name sont obligatoires' }); continue; }
        if (map.has(c.crm_id)) { errors.push({ file: 'clients', line, message: `crm_id en double : ${c.crm_id}` }); continue; }
        const sales = (c.sales_emails ?? '').split(/[\s,;|]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
        for (const e of sales) if (!emails.has(e)) warnings.push(`Ligne ${line} : commercial inconnu « ${e} » (affectation ignorée)`);
        map.set(c.crm_id, { crm_id: c.crm_id, name: c.name, address_line: c.address_line || undefined, postal_code: c.postal_code || undefined, city: c.city || undefined, country: c.country || undefined, sector: c.sector || undefined, contacts: [], sales_emails: sales });
      }
    }
    if (b.data.contacts_csv) {
      const p = parseCsv(b.data.contacts_csv);
      for (const h of ['company_crm_id', 'full_name']) if (!p.header.includes(h)) errors.push({ file: 'contacts', line: 1, message: `Colonne « ${h} » absente` });
      if (!errors.some(e => e.file === 'contacts')) {
        const n = new Map<string, number>();
        for (const { line, cells: c } of p.rows) {
          if (!c.company_crm_id || !c.full_name) { errors.push({ file: 'contacts', line, message: 'company_crm_id et full_name sont obligatoires' }); continue; }
          if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) { errors.push({ file: 'contacts', line, message: `e-mail invalide : ${c.email}` }); continue; }
          let co = map.get(c.company_crm_id);
          if (!co) {
            const ex = existingCompanies.get(c.company_crm_id);
            if (!ex) { errors.push({ file: 'contacts', line, message: `client inconnu : ${c.company_crm_id}` }); continue; }
            // client existant, absent du fichier clients : on ne modifie pas ses affectations (rien à toucher), on ajoute seulement des contacts
            const cur = (await pool.query(`SELECT array_agg(u.email::text) AS e FROM company c JOIN company_assignment a ON a.company_id = c.id AND a.removed_at IS NULL AND a.source = 'crm' JOIN app_user u ON u.id = a.user_id WHERE c.crm_id = $1`, [c.company_crm_id])).rows[0].e ?? [];
            co = { crm_id: c.company_crm_id, name: ex.name, address_line: ex.address_line ?? undefined, postal_code: ex.postal_code ?? undefined, city: ex.city ?? undefined, country: ex.country ?? undefined, sector: ex.sector ?? undefined, contacts: [], sales_emails: cur };
            map.set(c.company_crm_id, co);
          }
          const k = (n.get(c.company_crm_id) ?? 0) + 1; n.set(c.company_crm_id, k);
          co.contacts.push({ crm_id: c.crm_id || `${c.company_crm_id}-${k}`, full_name: c.full_name, job_title: c.job_title || undefined, phone: c.phone || undefined, email: c.email || undefined });
        }
      }
    }
    if (errors.length) throw new HttpError(422, 'import_invalid', `${errors.length} erreur(s) : rien n'a été importé`, { errors, warnings });
    const list = [...map.values()];
    if (b.data.dry_run) return void res.json({ dry_run: true, companies: list.length, contacts: list.reduce((n, c) => n + c.contacts.length, 0), warnings });
    const stats = await importCrm(pool, list);
    res.json({ dry_run: false, ...stats.result, warnings });
  }));

  return r;
}
