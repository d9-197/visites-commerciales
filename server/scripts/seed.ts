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
const mk = async (email: string, name: string, role: string, admin = false) =>
  (await pool.query(`INSERT INTO app_user(email, display_name, role, is_admin, password_hash) VALUES ($1,$2,$3,$4,$5)
                     ON CONFLICT (email) DO UPDATE SET display_name = $2 RETURNING id`, [email, name, role, admin, h])).rows[0].id as string;
const dir = await mk('directeur@exemple.invalid', 'Directeur Démo', 'directeur');
const mgr = await mk('manager@exemple.invalid', 'Manager Démo', 'manager');
const c1 = await mk('commercial1@exemple.invalid', 'Commercial Un', 'commercial');
const c2 = await mk('commercial2@exemple.invalid', 'Commercial Deux', 'commercial');
await mk('admin@exemple.invalid', 'Admin IT', 'commercial', true);

// Organisation : Entreprise > Agence Lyon. Le directeur est à la racine (il voit tout, de façon consolidée) ; le manager et les commerciaux sont dans l'agence.
const node = async (name: string, parent: string | null) =>
  ((await pool.query(`SELECT id FROM org_node WHERE name = $1 AND parent_id IS NOT DISTINCT FROM $2`, [name, parent])).rows[0]
    ?? (await pool.query(`INSERT INTO org_node(name, parent_id) VALUES ($1,$2) RETURNING id`, [name, parent])).rows[0]).id as string;
// Seulement si aucune organisation n'existe : relancé sur une base déjà configurée (SEED_DEMO=1 à chaque démarrage), le seed ne recrée ni ne modifie l'arbre
// (sinon il recréerait « Entreprise » après un renommage, avec deux branches de premier niveau, et ajouterait les comptes de démonstration à de nouvelles branches).
if (Number((await pool.query(`SELECT count(*)::int AS n FROM org_node`)).rows[0].n) === 0) {
  const root = await node('Entreprise', null);
  const lyon = await node('Agence Lyon', root);
  const member = (u: string, n: string) => pool.query(`INSERT INTO user_org(user_id, node_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [u, n]);
  await member(dir, root); await member(mgr, lyon); await member(c1, lyon); await member(c2, lyon);
  await pool.query('SELECT rebuild_org()');
}

await importCrm(pool, [
  { crm_id: 'D-001', name: 'Dupont SA', address_line: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country: 'France', sector: 'Industrie', contacts: [{ crm_id: 'D-001-1', full_name: 'M. Martin', job_title: 'Directeur achats' }], sales_emails: ['commercial1@exemple.invalid'] },
  { crm_id: 'D-002', name: 'Atelier Roux', address_line: '8 quai Jean Moulin', postal_code: '69100', city: 'Villeurbanne', contacts: [{ crm_id: 'D-002-1', full_name: 'Mme Roux', job_title: 'Gérante' }], sales_emails: ['commercial1@exemple.invalid', 'commercial2@exemple.invalid'] },
  { crm_id: 'D-003', name: 'Groupe Bernard', city: 'Grenoble', contacts: [], sales_emails: ['commercial2@exemple.invalid'] },
]);
console.log(`Données de démonstration prêtes. Comptes : commercial1@exemple.invalid, commercial2@exemple.invalid, manager@exemple.invalid, directeur@exemple.invalid, admin@exemple.invalid ${process.env.SEED_PASSWORD ? '(mot de passe : celui de SEED_PASSWORD)' : `(mot de passe : ${pwd})`}`);
await pool.end();
