// Test de bout en bout de l'application web, dans un navigateur au format téléphone.
// Prérequis : back démarré avec les données de démonstration (npm -w server run seed), application web construite.
// Usage : BASE_URL=http://127.0.0.1:3000 SHOTS=/dossier node e2e/web.cjs   (Playwright doit être installé)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const SHOTS = process.env.SHOTS;
const PWD = process.env.SEED_PASSWORD ?? 'demo-mot-de-passe-12';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function login(page, email) {
  await page.goto(BASE);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(PWD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByText('Synchronisé').waitFor();
}
const pad = n => String(n).padStart(2, '0');
const daysAgo = n => { const d = new Date(Date.now() - n * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const borderOf = async (loc) => loc.evaluate(el => getComputedStyle(el.parentElement).borderTopColor);
const newPhone = (browser, extra = {}) => browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, ...extra });

(async () => {
  const browser = await chromium.launch();
  const ctx = await newPhone(browser);
  const page = await ctx.newPage();
  // Les sites de cartographie ne sont pas appelés pour de vrai : on vérifie seulement l'adresse du lien ouvert.
  await ctx.route(/^https:\/\/(www\.google\.com|waze\.com|maps\.apple\.com)\//, r => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const status = () => page.getByText(/Synchronisé|Hors-ligne/).first().textContent();

  // 1. Connexion
  await page.goto(BASE);
  await page.getByLabel('E-mail').fill('commercial1@exemple.invalid');
  await page.getByLabel('Mot de passe').fill(PWD);
  await shot(page, '1-connexion');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByText('Synchronisé').waitFor();

  // 2. Clients reçus du CRM ; création d'une visite
  await page.getByRole('button', { name: 'Clients' }).click();
  await page.getByText('Dupont SA').waitFor();
  assert.ok(await page.getByText('Atelier Roux').isVisible());
  assert.equal(await page.getByText('Groupe Bernard').count(), 0, 'commercial1 ne voit pas le client de commercial2');
  await shot(page, '2-clients');
  await page.getByText('Dupont SA').click();

  // 2 bis. En-tête : « Retour » et nom du client sur la même ligne, nom centré
  const back = await page.getByRole('button', { name: '‹ Retour' }).boundingBox();
  const title = await page.getByRole('heading', { name: 'Dupont SA' }).boundingBox();
  assert.ok(Math.abs((back.y + back.height / 2) - (title.y + title.height / 2)) < 6, 'Retour et nom du client au même niveau');
  assert.ok(Math.abs((title.x + title.width / 2) - 195) < 12, 'nom du client centré');
  // pas de champ d'adresse ni de date dans la vue : seulement des icônes de modification
  assert.equal(await page.getByLabel('Adresse de la visite', { exact: true }).count(), 0, 'le champ d\'adresse n\'est pas dans la vue visite');
  assert.equal(await page.getByLabel('Date et heure prévues', { exact: true }).count(), 0, 'le champ de date n\'est pas dans la vue visite');
  assert.ok(await page.getByText('À organiser', { exact: true }).first().isVisible(), 'statut initial : à organiser');
  assert.ok(await page.getByText('12 rue des Lilas, 69003 Lyon, France').first().isVisible(), 'adresse du client par défaut, libellée « Adresse de la visite »');
  assert.ok(await page.getByText('Adresse de la visite', { exact: true }).first().isVisible());
  await shot(page, '3-visite');

  // 2 bis bis. Bouton retour du téléphone (historique du navigateur) : remonte l'application, ne la quitte pas
  await page.getByRole('link', { name: 'Ouvrir l\'itinéraire' }).click();
  await page.getByText('Ouvrir l\'itinéraire avec…').waitFor();
  await page.goBack();                                                   // ferme la fenêtre d'itinéraire
  await page.getByText('Ouvrir l\'itinéraire avec…').waitFor({ state: 'detached' });
  assert.equal(page.url().startsWith(BASE), true, 'toujours dans l\'application');
  assert.ok(await page.getByRole('heading', { name: 'Dupont SA' }).isVisible(), 'toujours sur la visite');
  await page.goBack();                                                   // retour de la visite vers la liste des clients
  await page.getByText('Source : CRM, lecture seule').waitFor();
  assert.equal(page.url().startsWith(BASE), true, 'le retour n\'a pas quitté l\'application');
  await page.goForward();
  await page.getByRole('heading', { name: 'Dupont SA' }).waitFor();

  // 2 ter. Itinéraire : choix de l'application au clic sur l'adresse
  await page.getByRole('link', { name: 'Ouvrir l\'itinéraire' }).click();
  await page.getByText('Ouvrir l\'itinéraire avec…').waitFor();
  const labels = await page.getByRole('button').allTextContents();
  assert.ok(labels.includes('Google Maps') && labels.includes('Waze'), 'choix de l\'application proposé');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Google Maps' }).click();
  const url = (await popup).url();
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?api=1&destination=12%20rue%20des%20Lilas'), `lien Google Maps : ${url}`);

  // 2 quater. Adresse : modifiable par l'icône (la visite n'est pas encore organisée)
  await page.getByRole('button', { name: 'Modifier l\'adresse de la visite' }).click();
  await page.getByLabel('Adresse de la visite', { exact: true }).fill('3 place Bellecour, 69002 Lyon');
  await page.getByRole('button', { name: 'Enregistrer' }).last().click();
  await page.getByText('3 place Bellecour, 69002 Lyon').first().waitFor();

  // 2 quinquies. Date prévue : icône, sélecteur de date et d'heure, historique conservé
  await page.getByRole('button', { name: 'Modifier la date prévue' }).click();
  assert.equal(await page.getByLabel('Date et heure prévues', { exact: true }).getAttribute('type'), 'datetime-local', 'sélecteur natif de date et d\'heure');
  await page.getByLabel('Date et heure prévues', { exact: true }).fill('2026-12-01T14:30');
  await page.getByRole('button', { name: 'Enregistrer' }).last().click();
  await page.getByText(/déc\.? 2026.*14:30/).first().waitFor();
  assert.equal(await page.getByText('En retard').count(), 0, 'date future : pas en retard');
  await page.getByRole('button', { name: /Historique des modifications \(2\)/ }).click();
  await page.getByText('Date prévue', { exact: true }).last().waitFor();
  assert.ok(await page.getByText(/12 rue des Lilas, 69003 Lyon, France\s+→\s+3 place Bellecour/).isVisible(), 'ancienne et nouvelle adresse dans l\'historique');
  assert.ok(await page.getByText(/→\s+.*déc\.? 2026.*14:30/).isVisible(), 'ancienne et nouvelle date dans l\'historique');
  await shot(page, '3b-historique');
  await page.getByRole('button', { name: 'Fermer' }).last().click();

  // 2 sexies. Statuts : libellés clairs ; organisée ; démarrée : plus d'édition de l'adresse ni de la date
  await page.getByRole('button', { name: 'Visite organisée avec le client' }).click();
  await page.getByText('Organisée', { exact: true }).first().waitFor();
  assert.ok(await page.getByRole('button', { name: 'Modifier l\'adresse de la visite' }).isVisible(), 'commercial : adresse encore modifiable une fois organisée');
  await page.getByRole('button', { name: 'Démarrer la visite' }).click();
  await page.getByText('En cours', { exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Modifier l\'adresse de la visite' }).count(), 0, 'adresse non modifiable une fois la visite commencée');
  assert.equal(await page.getByRole('button', { name: 'Modifier la date prévue' }).count(), 0, 'date prévue non modifiable une fois la visite commencée');
  await page.getByLabel('Nouvelle note').fill('M. Martin intéressé par l\'offre B');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  await page.getByLabel('Résumé du compte rendu').fill('Intéressé par l\'offre B, budget à confirmer.');
  await page.getByRole('button', { name: 'Valider' }).click();
  await page.getByRole('button', { name: 'Terminer la visite' }).click();
  await page.getByText('Terminée', { exact: true }).first().waitFor();
  await shot(page, '3c-terminee');
  await page.getByRole('button', { name: '‹ Retour' }).click();
  await page.getByText('Source : CRM, lecture seule').waitFor();       // « Retour » ramène à l'écran d'où l'on vient (Clients)
  await page.getByRole('button', { name: 'Visites' }).click();

  // 2 septies. Liste : regroupement par client / par date, dates réalisée et prévue
  await page.getByText('1 visite', { exact: true }).waitFor();
  await page.getByText(/^Réalisée /).waitFor();
  assert.ok(await page.getByText(/^Prévue .*déc/).first().isVisible(), 'la date prévue reste affichée sous la date réalisée');
  await shot(page, '3d-visites-par-client');
  await page.getByRole('radio', { name: 'Par date' }).click();
  await page.getByText('Dupont SA', { exact: true }).first().waitFor();
  await page.getByRole('radio', { name: 'Par client' }).click();

  // 3. Action : sélecteur de date, échéance affichée en clair
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('button', { name: '+ Nouvelle' }).click();
  await page.getByLabel('Intitulé de l\'action').fill('Envoyer le devis');
  assert.equal(await page.getByLabel('Échéance').getAttribute('type'), 'date', 'sélecteur natif de date');
  await page.getByLabel('Échéance').fill('2026-11-26');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Envoyer le devis').waitFor();
  assert.ok(await page.getByText(/jeu\.? 26 nov\.? 2026/).first().isVisible(), 'échéance affichée en clair, pas en AAAA-MM-JJ');
  // Action dont l'échéance est passée : identifiable visuellement
  await page.getByRole('button', { name: '+ Nouvelle' }).click();
  await page.getByLabel('Intitulé de l\'action').fill('Relancer le client (en retard)');
  await page.getByLabel('Échéance').fill(daysAgo(5));
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Relancer le client (en retard)').waitFor();
  assert.equal(await page.getByText('En retard', { exact: true }).count(), 1, 'seule l\'action dont l\'échéance est passée est signalée en retard');
  assert.equal(await borderOf(page.getByText('En retard', { exact: true })), 'rgb(198, 40, 40)', 'pastille « En retard » en rouge');
  await shot(page, '4-actions');

  // 4. Hors-ligne : saisie locale, file en attente, puis reconnexion
  await ctx.setOffline(true);
  await page.getByRole('button', { name: '+ Nouvelle' }).click();
  await page.getByLabel('Intitulé de l\'action').fill('Appeler Mme Roux (hors-ligne)');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Appeler Mme Roux (hors-ligne)').waitFor();
  await page.getByText('Synchroniser').click();
  await page.getByText(/Hors-ligne.*en attente/).waitFor();
  await shot(page, '5-hors-ligne');
  await ctx.setOffline(false);
  await page.getByText('Synchroniser').click();
  await page.getByText('Synchronisé').waitFor();
  assert.equal(/en attente/.test(await status()), false);

  // 5. Les données survivent à un rechargement
  await page.reload();
  await page.getByText('Synchronisé').waitFor();
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByText('Appeler Mme Roux (hors-ligne)').waitFor();
  await page.getByText('Envoyer le devis').waitFor();

  // 6. Terminer une action, puis déconnexion qui efface les données de l'appareil
  await page.getByRole('checkbox').first().click();
  await page.getByRole('button', { name: 'Réglages' }).click();
  await page.getByRole('button', { name: /Se déconnecter/ }).click();
  await page.getByRole('button', { name: 'Se connecter' }).waitFor();
  const left = await page.evaluate(() => [localStorage.getItem('visites.store.v1'), localStorage.getItem('visites.session.v1')]);
  assert.deepEqual(left, [null, null], 'rien ne doit rester sur l\'appareil après la déconnexion');

  // 7. Droits : un manager voit la visite d'un commercial « à organiser » et peut corriger l'adresse, pas la date
  const c1 = await newPhone(browser); const p1 = await c1.newPage();
  p1.on('pageerror', e => errors.push(e.message));
  await login(p1, 'commercial1@exemple.invalid');
  await p1.getByRole('button', { name: 'Clients' }).click();
  await p1.getByText('Atelier Roux').click();
  await p1.getByText('À organiser', { exact: true }).first().waitFor();
  assert.equal(await borderOf(p1.getByText('À organiser', { exact: true }).first()), 'rgb(168, 104, 10)', 'statut « à organiser » en ambre');
  assert.equal(await p1.getByText('En retard', { exact: true }).count(), 0, 'visite créée à l\'instant : pas en retard');
  await p1.getByRole('button', { name: 'Modifier la date prévue' }).click();
  await p1.getByLabel('Date et heure prévues', { exact: true }).fill(`${daysAgo(3)}T09:00`);
  await p1.getByRole('button', { name: 'Enregistrer' }).last().click();
  await p1.getByText('En retard', { exact: true }).first().waitFor();
  assert.equal(await borderOf(p1.getByText('En retard', { exact: true }).first()), 'rgb(198, 40, 40)', 'visite en retard : pastille rouge');
  await shot(p1, '3e-visite-en-retard');
  await p1.getByRole('button', { name: 'Synchroniser' }).click();     // la visite part au serveur avant que le manager la lise
  await p1.getByText('Synchronisé').waitFor();
  const mctx = await newPhone(browser); const mp = await mctx.newPage();
  mp.on('pageerror', e => errors.push(e.message));
  await login(mp, 'manager@exemple.invalid');
  await mp.getByRole('radio', { name: 'Par date' }).click();           // une ligne par visite, avec le nom du client
  await mp.getByText('Atelier Roux').first().click();
  assert.equal(await mp.getByRole('button', { name: 'Modifier la date prévue' }).count(), 0, 'le manager ne modifie pas la date');
  await mp.getByRole('button', { name: 'Modifier l\'adresse de la visite' }).click();
  await mp.getByLabel('Adresse de la visite', { exact: true }).fill('Entrée B, 8 quai Jean Moulin, Villeurbanne');
  await mp.getByRole('button', { name: 'Enregistrer' }).last().click();
  await mp.getByText('Entrée B, 8 quai Jean Moulin, Villeurbanne').first().waitFor();
  await mp.getByRole('button', { name: 'Synchroniser' }).click();
  await mp.getByText('Synchronisé').waitFor();
  // le commercial reçoit la correction et voit qui l'a faite
  await p1.getByRole('button', { name: 'Synchroniser' }).click();
  await p1.getByText('Entrée B, 8 quai Jean Moulin, Villeurbanne').first().waitFor();
  await p1.getByRole('button', { name: /Historique des modifications \(2\)/ }).click();
  await p1.getByText(/Manager Démo/).waitFor();
  // une fois la visite organisée, le manager ne peut plus modifier l'adresse (le serveur refuse, l'icône disparaît)
  await p1.getByRole('button', { name: 'Fermer' }).last().click();
  await p1.getByRole('button', { name: 'Visite organisée avec le client' }).click();
  await p1.getByText('Organisée', { exact: true }).first().waitFor();
  assert.equal(await borderOf(p1.getByText('Organisée', { exact: true }).first()), 'rgb(14, 106, 135)', 'statut « organisée » en bleu');
  await p1.getByRole('button', { name: 'Synchroniser' }).click();
  await p1.getByText('Synchronisé').waitFor();
  await mp.getByRole('button', { name: 'Synchroniser' }).click();
  await mp.getByText('Organisée', { exact: true }).first().waitFor();
  await mp.getByRole('button', { name: '‹ Retour' }).click();
  await mp.getByRole('radio', { name: 'Par client' }).click();
  await mp.getByText(/1 en retard/).waitFor();
  await shot(mp, '3f-liste-retard');
  assert.equal(await mp.getByRole('button', { name: 'Modifier l\'adresse de la visite' }).count(), 0, 'manager : plus de modification d\'adresse une fois la visite organisée');
  await c1.close(); await mctx.close();

  // 8. Mode sombre : suit le réglage du système par défaut, réglable, conservé après rechargement et déconnexion
  const bg = p => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const dctx = await newPhone(browser, { colorScheme: 'dark' });
  const dp = await dctx.newPage();
  dp.on('pageerror', e => errors.push(e.message));
  await dp.goto(BASE);
  await dp.getByRole('button', { name: 'Se connecter' }).waitFor();
  assert.equal(await bg(dp), 'rgb(12, 19, 23)', 'sombre par défaut quand le système est sombre');
  await dp.getByLabel('E-mail').fill('commercial1@exemple.invalid');
  await dp.getByLabel('Mot de passe').fill(PWD);
  await dp.getByRole('button', { name: 'Se connecter' }).click();
  await dp.getByText('Synchronisé').waitFor();
  await shot(dp, '6-sombre');
  await dp.getByRole('button', { name: 'Réglages' }).click();
  await dp.getByRole('radio', { name: 'Clair' }).click();
  await dp.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(244, 246, 245)');
  await dp.reload();
  await dp.getByText('Synchronisé').waitFor();
  assert.equal(await bg(dp), 'rgb(244, 246, 245)', 'le choix « Clair » survit au rechargement');
  await dp.getByRole('button', { name: 'Réglages' }).click();
  await dp.getByRole('radio', { name: 'Système' }).click();
  await dp.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(12, 19, 23)');
  await dp.getByRole('radio', { name: 'Sombre' }).click();
  await dp.getByRole('button', { name: /Se déconnecter/ }).click();
  await dp.getByRole('button', { name: 'Se connecter' }).waitFor();
  assert.equal(await bg(dp), 'rgb(12, 19, 23)', 'le réglage d\'affichage est conservé après la déconnexion');
  await dctx.close();

  assert.deepEqual(errors, [], 'aucune erreur JavaScript dans la page');
  await browser.close();
  console.log('E2E web : OK');
})().catch(e => { console.error('E2E web : ÉCHEC\n', e); process.exit(1); });
