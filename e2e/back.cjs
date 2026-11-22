// Test de bout en bout de l'application back (PC) : administration des comptes, maquette du CRM, reporting, préparation des visites.
// Prérequis : back démarré avec les données de démonstration (seed), application back construite (cd back && npm run build).
// Usage : BASE_URL=http://127.0.0.1:3000 SHOTS=/dossier node e2e/back.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const SHOTS = process.env.SHOTS;
const PWD = process.env.SEED_PASSWORD ?? 'demo-mot-de-passe-12';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function login(page, email, pwd = PWD) {
  await page.goto(`${BASE}/admin`);                               // redirigé vers /admin/
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(pwd);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByRole('navigation').waitFor();
}
const nav = (page, name) => page.getByRole('navigation').getByRole('link', { name }).click();
const dialog = page => page.getByRole('dialog');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/401|403|404|409|422/.test(m.text())) errors.push(m.text()); });

  // 0. Connexion : marque (nom/logo) de l'entreprise, mauvais mot de passe refusé
  await page.goto(`${BASE}/admin`);
  assert.match(page.url(), /\/admin\/$/, '/admin redirige vers /admin/');
  await page.getByRole('heading', { name: 'ACME Industrie' }).waitFor();
  await page.getByLabel('E-mail').fill('admin@exemple.invalid');
  await page.getByLabel('Mot de passe').fill('mauvais-mot-de-passe');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByText('Identifiants incorrects.').waitFor();
  await shot(page, 'b0-connexion');

  // 1. Administrateur : toutes les rubriques
  await login(page, 'admin@exemple.invalid');
  for (const n of ['Reporting', 'Préparation', 'Visites', 'Comptes', /Clients/]) await page.getByRole('navigation').getByRole('link', { name: n }).waitFor();
  assert.equal(await page.title(), 'ACME Industrie – Back office');

  // 2. Maquette du CRM : créer un client, l'affecter, ajouter un contact
  await nav(page, /Clients/);
  await page.getByRole('heading', { name: /Clients \(maquette/ }).waitFor();
  await page.getByText('Dupont SA').waitFor();
  await page.getByRole('button', { name: '+ Nouveau client' }).click();
  await dialog(page).getByLabel('Nom', { exact: true }).fill('Quincaillerie Test');
  await dialog(page).getByLabel('Adresse', { exact: true }).fill('3 rue de la Paix');
  await dialog(page).getByLabel('Ville').fill('Lyon');
  await dialog(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await dialog(page).getByText('Enregistré.').waitFor();
  const cu = dialog(page).getByRole('checkbox', { name: /Commercial Un/ });
  await cu.click();
  for (let i = 0; i < 40 && !(await cu.isChecked()); i++) await page.waitForTimeout(100);   // affectation enregistrée puis relue
  assert.equal(await cu.isChecked(), true, 'commercial affecté');
  await dialog(page).getByRole('button', { name: '+ Ajouter' }).click();
  await dialog(page).getByLabel('Nom', { exact: true }).last().fill('Mme Test');
  await dialog(page).getByLabel('E-mail').fill('test@quincaillerie.example');
  await dialog(page).getByRole('button', { name: 'Enregistrer le contact' }).click();
  await dialog(page).getByRole('cell', { name: 'Mme Test' }).waitFor();
  await shot(page, 'b1-client');
  await dialog(page).getByRole('button', { name: 'Fermer', exact: true }).last().click();
  await page.getByRole('cell', { name: 'Quincaillerie Test' }).waitFor();

  // 3. Import CSV : aperçu, erreur bloquante, import
  await page.getByRole('button', { name: 'Importer un CSV' }).click();
  const files = dialog(page).locator('input[type=file]');
  await files.first().setInputFiles({ name: 'clients.csv', mimeType: 'text/csv', buffer: Buffer.from('crm_id;name;city;sales_emails\nIMP-1;Import Un;Paris;commercial1@exemple.invalid\nIMP-2;;Lille;\n') });
  await dialog(page).getByRole('button', { name: 'Vérifier' }).click();
  await dialog(page).getByText(/crm_id et name sont obligatoires/).waitFor();
  assert.equal(await dialog(page).getByRole('button', { name: 'Importer', exact: true }).isDisabled(), true, 'import bloqué tant que la vérification échoue');
  await files.first().setInputFiles({ name: 'clients.csv', mimeType: 'text/csv', buffer: Buffer.from('crm_id;name;city;sales_emails\nIMP-1;Import Un;Paris;commercial1@exemple.invalid\nIMP-2;"Import ""Deux"", SA";Lille;inconnu@exemple.invalid\n') });
  await files.nth(1).setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from('company_crm_id;full_name;email\nIMP-1;Jean Import;jean@import.example\n') });
  await dialog(page).getByRole('button', { name: 'Vérifier' }).click();
  await dialog(page).getByText(/Vérification réussie : 2 client\(s\), 1 contact\(s\)/).waitFor();
  await dialog(page).getByText(/commercial inconnu « inconnu@exemple.invalid »/).waitFor();
  await dialog(page).getByRole('button', { name: 'Importer', exact: true }).click();
  await dialog(page).getByText(/Import terminé/).waitFor();
  await dialog(page).getByRole('button', { name: 'Fermer', exact: true }).last().click();
  await page.getByLabel('Rechercher un client').fill('Import');
  await page.getByRole('cell', { name: 'Import "Deux", SA' }).waitFor();

  // 4. Comptes : création (mot de passe temporaire affiché une fois), connexion du nouveau compte, désactivation
  await nav(page, 'Comptes');
  await page.getByRole('button', { name: '+ Nouveau compte' }).click();
  await dialog(page).getByLabel('Nom affiché').fill('Nina Nouvelle');
  await dialog(page).getByLabel('E-mail', { exact: true }).fill('nina@exemple.invalid');
  await dialog(page).getByRole('checkbox', { name: 'Agence Lyon' }).check();             // branche de l'organisation (le rôle est le même partout)
  await dialog(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('heading', { name: 'Mot de passe temporaire' }).waitFor();
  const temp = await page.locator('code.secret').innerText();
  assert.ok(temp.length >= 16);
  await shot(page, 'b2-mot-de-passe');
  await page.getByRole('button', { name: /J'ai noté/ }).click();
  await page.getByRole('cell', { name: 'nina@exemple.invalid' }).waitFor();
  await page.getByText('Visibilité des comptes rendus').waitFor();
  await shot(page, 'b3-comptes');
  const c2 = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const p2 = await c2.newPage();
  await login(p2, 'nina@exemple.invalid', temp);                  // le nouveau compte se connecte avec le mot de passe temporaire
  assert.equal(await p2.getByRole('navigation').getByRole('link', { name: 'Comptes' }).count(), 0, 'un commercial ne voit pas la rubrique Comptes');
  await p2.getByRole('heading', { name: "Reporting d'activité" }).waitFor();
  await page.getByRole('row', { name: /Nina Nouvelle/ }).getByRole('button', { name: 'Désactiver' }).click();
  await page.getByRole('row', { name: /Nina Nouvelle/ }).getByText('Désactivé').waitFor();
  await p2.reload();                                               // session révoquée : retour à la connexion
  await p2.getByRole('button', { name: 'Se connecter' }).waitFor();
  await c2.close();

  // 4 bis. Organisation arborescente : sous-branche, règles de suppression (au survol), commercial dans plusieurs branches
  await nav(page, 'Organisation');
  await page.getByRole('heading', { name: 'Organisation' }).waitFor();
  const rowOf = n => page.getByRole('row').filter({ hasText: n }).first();
  await rowOf('Agence Lyon').waitFor();
  assert.match(await rowOf('Agence Lyon').locator('.tip').getAttribute('title'), /utilisateurs sont affectés/, 'suppression impossible : raison au survol');
  for (const name of ['Agence Grenoble', 'Temporaire']) {
    await rowOf('Entreprise').getByRole('button', { name: '+ Sous-branche' }).click();
    await dialog(page).getByLabel('Nom de la branche').fill(name);
    await dialog(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await rowOf(name).waitFor();
  }
  await rowOf('Temporaire').getByRole('button', { name: 'Supprimer' }).click();               // branche vide : supprimée
  await page.getByRole('row').filter({ hasText: 'Temporaire' }).waitFor({ state: 'detached' });
  // arbre à plusieurs niveaux : niveaux distincts, branches repliables
  await rowOf('Agence Lyon').getByRole('button', { name: '+ Sous-branche' }).click();
  await dialog(page).getByLabel('Nom de la branche').fill('Équipe Nord');
  await dialog(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await rowOf('Équipe Nord').waitFor();
  assert.equal(await rowOf('Équipe Nord').getByText('Niveau 3', { exact: true }).count(), 1, 'niveau affiché');
  assert.equal(await rowOf('Entreprise').getByText('Niveau 1', { exact: true }).count(), 1);
  // plusieurs branches de premier niveau : création et suppression d'une branche vide de premier niveau
  await page.getByRole('button', { name: '+ Branche de premier niveau' }).click();
  await dialog(page).getByLabel('Nom de la branche').fill('Premier niveau test');
  await dialog(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await rowOf('Premier niveau test').waitFor();
  assert.equal(await rowOf('Premier niveau test').getByText('Niveau 1', { exact: true }).count(), 1, 'deuxième branche de premier niveau');
  await rowOf('Premier niveau test').getByRole('button', { name: 'Supprimer' }).click();
  await page.getByRole('row').filter({ hasText: 'Premier niveau test' }).waitFor({ state: 'detached' });
  await shot(page, 'b2b-organisation');
  await page.getByRole('button', { name: 'Replier la branche Agence Lyon' }).click();
  await page.getByRole('row').filter({ hasText: 'Équipe Nord' }).waitFor({ state: 'detached' });
  await rowOf('Agence Lyon').getByText('+1', { exact: true }).waitFor();
  await shot(page, 'b2b-organisation-repliee');
  await page.getByRole('button', { name: 'Déplier la branche Agence Lyon' }).click();
  await rowOf('Équipe Nord').waitFor();
  await page.getByRole('button', { name: 'Tout replier' }).click();
  await page.getByRole('row').filter({ hasText: 'Équipe Nord' }).waitFor({ state: 'detached' });
  await page.getByRole('row').filter({ hasText: 'Agence Lyon' }).waitFor({ state: 'detached' });     // « Tout replier » replie aussi le premier niveau : seule la branche de premier niveau reste
  await rowOf('Entreprise').getByText('+', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Tout déplier' }).click();
  await rowOf('Équipe Nord').waitFor();
  await nav(page, 'Comptes');
  await page.getByRole('row', { name: /Commercial Deux/ }).getByRole('button', { name: 'Modifier' }).click();
  // sélecteur de branches : arbre avec niveaux, repli, récapitulatif des choix
  await dialog(page).getByRole('checkbox', { name: 'Équipe Nord' }).waitFor();
  assert.equal(await dialog(page).getByRole('checkbox', { name: 'Agence Lyon' }).isChecked(), true, 'branche actuelle cochée');
  await dialog(page).getByLabel('Branches choisies').getByText('Agence Lyon').waitFor();
  await shot(page, 'b2d-compte-branches');
  await dialog(page).getByRole('checkbox', { name: 'Équipe Nord' }).check();
  await dialog(page).getByRole('button', { name: 'Replier la branche Agence Lyon' }).click();
  await dialog(page).getByRole('checkbox', { name: 'Équipe Nord' }).waitFor({ state: 'detached' });
  await dialog(page).getByText(/^\+1 · 1 cochée$/).waitFor();                 // le repli signale les choix qu'il masque
  await dialog(page).getByRole('button', { name: 'Déplier la branche Agence Lyon' }).click();
  await dialog(page).getByRole('checkbox', { name: 'Équipe Nord' }).uncheck();
  await dialog(page).getByRole('checkbox', { name: 'Agence Grenoble' }).check();
  await dialog(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('row', { name: /Commercial Deux/ }).getByText('Agence Grenoble').waitFor();
  // application mobile : Commercial Deux (deux branches) choisit la branche à la création d'une visite
  const octx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const op2 = await octx.newPage(); op2.on('pageerror', e => errors.push(e.message));
  await op2.goto(BASE);
  await op2.getByLabel('E-mail').fill('commercial2@exemple.invalid'); await op2.getByLabel('Mot de passe').fill(PWD);
  await op2.getByRole('button', { name: 'Se connecter' }).click();
  await op2.getByText('Synchronisé').waitFor();
  await op2.getByRole('button', { name: 'Clients', exact: true }).click();
  await op2.getByText('Atelier Roux').click();
  await op2.getByRole('button', { name: '+ Planifier une visite' }).click();
  await op2.getByText('Pour quelle branche ?').waitFor();
  await shot(op2, 'b2c-choix-branche');
  await op2.getByRole('button', { name: 'Entreprise › Agence Grenoble' }).click();
  await op2.getByText('Statut', { exact: true }).waitFor();
  await op2.getByText('Branche', { exact: true }).waitFor();
  await op2.getByText('Agence Grenoble', { exact: true }).waitFor();
  await octx.close();

  // 5. Préparation : le client sans visite est suggéré ; fiche ; planification pour Commercial Un
  await nav(page, 'Préparation');
  await page.getByRole('row', { name: /Quincaillerie Test/ }).getByText('Jamais visité').waitFor();
  await shot(page, 'b4-suggestions');
  await page.getByRole('row', { name: /Quincaillerie Test/ }).getByRole('button', { name: 'Préparer' }).click();
  await dialog(page).getByRole('heading', { name: 'Préparer : Quincaillerie Test' }).waitFor();
  await dialog(page).getByText('Mme Test').waitFor();
  await shot(page, 'b5-fiche');
  await dialog(page).getByRole('button', { name: 'Planifier une visite' }).click();
  await dialog(page).locator('select').first().selectOption({ label: 'Commercial Un' });
  await dialog(page).getByLabel('Objectif', { exact: true }).fill('Présenter la gamme 2027');
  await dialog(page).getByLabel('Points à aborder').fill('Apporter le catalogue ; parler du contrat cadre');
  await dialog(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('row', { name: /Quincaillerie Test/ }).getByText('À organiser').waitFor();   // onglet Planning
  await shot(page, 'b6-planning');
  // le commercial reçoit la visite à sa synchronisation (API mobile)
  const tok = await (await fetch(`${BASE}/api/mobile/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'commercial1@exemple.invalid', password: PWD, device: { platform: 'web', app_version: '1.0.0' } }) })).json();
  const pull = await (await fetch(`${BASE}/api/mobile/v1/sync/pull?limit=200`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  const v = (pull.changes.visits ?? []).find(x => x.objective === 'Présenter la gamme 2027');
  assert.ok(v, 'la visite planifiée arrive chez le commercial');
  assert.equal(v.preparation_notes, 'Apporter le catalogue ; parler du contrat cadre'); assert.ok(v.created_by);
  // le client prévu n'est plus suggéré (visite déjà planifiée)
  await page.getByRole('tab', { name: 'Clients à visiter' }).click();
  await page.getByText(/Aucun client à signaler|Dupont SA|Atelier Roux|Import/).first().waitFor();
  assert.equal(await page.getByRole('row', { name: /Quincaillerie Test/ }).count(), 0, 'client déjà planifié : plus suggéré');
  // modification du rendez-vous
  await page.getByRole('tab', { name: 'Planning' }).click();
  await page.getByRole('row', { name: /Quincaillerie Test/ }).getByRole('button', { name: 'Modifier' }).click();
  await dialog(page).getByLabel('Statut').selectOption('organized');
  await dialog(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('row', { name: /Quincaillerie Test/ }).getByText('Organisée').waitFor();

  // 6. Visites : la visite planifiée est consultable ; détail
  await nav(page, 'Visites');
  await page.getByRole('cell', { name: 'Quincaillerie Test' }).click();
  await dialog(page).getByText('Présenter la gamme 2027').waitFor();
  await dialog(page).getByText(/Apporter le catalogue/).waitFor();
  await dialog(page).getByText(/planifiée par/).waitFor();
  await dialog(page).getByRole('button', { name: 'Fermer', exact: true }).last().click();

  // 6 bis. Application mobile : le commercial voit la préparation (objectif, points à aborder, qui a planifié)
  const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });
  const ph = await mctx.newPage(); ph.on('pageerror', e => errors.push(e.message));
  await ph.goto(BASE);
  await ph.getByLabel('E-mail').fill('commercial1@exemple.invalid'); await ph.getByLabel('Mot de passe').fill(PWD);
  await ph.getByRole('button', { name: 'Se connecter' }).click();
  await ph.getByText('Synchronisé').waitFor();
  await ph.getByText(/^Prévue /).first().click();
  await ph.getByLabel('Préparation de la visite').waitFor();
  await ph.getByText('Présenter la gamme 2027').waitFor();
  await ph.getByText('Apporter le catalogue ; parler du contrat cadre').waitFor();
  await ph.getByText('Planifiée par Admin IT').waitFor();
  await shot(ph, 'b6b-mobile-preparation');
  await mctx.close();

  // 7. Reporting : indicateurs et export
  await nav(page, 'Reporting');
  await page.getByText('Visites effectuées', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Par commercial' }).waitFor();
  await page.getByRole('heading', { name: /Par branche/ }).waitFor();                 // consolidation par branche
  await page.getByRole('button', { name: 'Agence Grenoble' }).first().waitFor();
  await page.getByRole('button', { name: 'Replier la branche Agence Lyon' }).click();            // repli aussi dans le reporting par branche
  await page.getByRole('row').filter({ hasText: 'Équipe Nord' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Déplier la branche Agence Lyon' }).click();
  await page.getByRole('row').filter({ hasText: 'Équipe Nord' }).waitFor();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter en CSV' }).click();
  const file = await dl; assert.match(file.suggestedFilename(), /^activite-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
  await shot(page, 'b7-reporting');

  // 7 bis. Réaffecter les visites d'une branche à une autre (pour la vider avant de la supprimer)
  await nav(page, 'Organisation');
  await rowOf('Agence Grenoble').getByRole('button', { name: 'Réaffecter les visites' }).click();         // la visite de Commercial Deux y a été créée sur mobile
  await dialog(page).getByText(/Commercial Deux \(1\)/).waitFor();
  const lyon = await dialog(page).locator('option', { hasText: 'Agence Lyon' }).first().getAttribute('value');
  await dialog(page).locator('select').selectOption(lyon);
  await shot(page, 'b7b-reaffecter');
  await dialog(page).getByRole('button', { name: /^Réaffecter 1 visite/ }).click();
  await page.getByText(/1 visite réaffectée à « Agence Lyon »/).waitFor();
  assert.equal(await rowOf('Agence Grenoble').getByRole('button', { name: 'Réaffecter les visites' }).count(), 0, 'plus de visite dans la branche vidée');

  // 8. Manager : périmètre limité (pas de comptes), planification pour son équipe seulement
  const c3 = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const mp = await c3.newPage();
  mp.on('pageerror', e => errors.push(e.message));
  await login(mp, 'manager@exemple.invalid');
  assert.equal(await mp.getByRole('navigation').getByRole('link', { name: /Clients|Comptes/ }).count(), 0, 'le manager n\'a pas l\'administration');
  await mp.getByRole('heading', { name: "Reporting d'activité" }).waitFor();
  assert.equal(await mp.getByRole('cell', { name: 'Commercial Deux' }).count() + await mp.getByRole('cell', { name: 'Commercial Un' }).count() >= 1, true);
  const bad = await mp.evaluate(async () => { const t = JSON.parse(sessionStorage.getItem('vb.tokens')); const r = await fetch('../api/back/v1/users', { headers: { authorization: `Bearer ${t.access_token}` } }); return r.status; });
  assert.equal(bad, 403, 'API des comptes interdite au manager');
  await c3.close();

  assert.deepEqual(errors, [], 'aucune erreur JavaScript');
  await browser.close();
  console.log('E2E back : OK');
})().catch(e => { console.error('E2E back : ÉCHEC\n', e); process.exit(1); });
