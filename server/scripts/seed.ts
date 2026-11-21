// Données de démonstration : schéma + utilisateurs + quelques clients. Usage : DATABASE_URL=... npm -w server run seed
import { createPool } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { importCrm } from '../src/crm-import.js';
import { migrate } from '../src/migrate.js';

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/visites');
await migrate(pool);

if (process.env.NODE_ENV === 'production' && !process.env.SEED_PASSWORD) { console.error('SEED_PASSWORD est obligatoire en production.'); process.exit(1); }
const pwd = process.env.SEED_PASSWORD ?? 'demo-mot-de-passe-12';
const h = await hashPassword(pwd);
const mk = async (email: string, name: string, role: string, manager?: string, admin = false) =>
  (await pool.query(`INSERT INTO app_user(email, display_name, role, manager_id, is_admin, password_hash) VALUES ($1,$2,$3,$4,$5,$6)
                     ON CONFLICT (email) DO UPDATE SET display_name = $2 RETURNING id`, [email, name, role, manager ?? null, admin, h])).rows[0].id as string;
const dir = await mk('directeur@exemple.invalid', 'Directeur Démo', 'directeur');
const mgr = await mk('manager@exemple.invalid', 'Manager Démo', 'manager', dir);
await mk('commercial1@exemple.invalid', 'Commercial Un', 'commercial', mgr);
await mk('commercial2@exemple.invalid', 'Commercial Deux', 'commercial', mgr);
await mk('admin@exemple.invalid', 'Admin IT', 'commercial', undefined, true);
await pool.query('SELECT rebuild_hierarchy()');

await importCrm(pool, [
  { crm_id: 'D-001', name: 'Dupont SA', address_line: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country: 'France', sector: 'Industrie', contacts: [{ crm_id: 'D-001-1', full_name: 'M. Martin', job_title: 'Directeur achats' }], sales_emails: ['commercial1@exemple.invalid'] },
  { crm_id: 'D-002', name: 'Atelier Roux', address_line: '8 quai Jean Moulin', postal_code: '69100', city: 'Villeurbanne', contacts: [{ crm_id: 'D-002-1', full_name: 'Mme Roux', job_title: 'Gérante' }], sales_emails: ['commercial1@exemple.invalid', 'commercial2@exemple.invalid'] },
  { crm_id: 'D-003', name: 'Groupe Bernard', city: 'Grenoble', contacts: [], sales_emails: ['commercial2@exemple.invalid'] },
]);
console.log(`Données de démonstration prêtes. Comptes : commercial1@exemple.invalid, commercial2@exemple.invalid, manager@exemple.invalid, directeur@exemple.invalid, admin@exemple.invalid ${process.env.SEED_PASSWORD ? '(mot de passe : celui de SEED_PASSWORD)' : `(mot de passe : ${pwd})`}`);
await pool.end();
