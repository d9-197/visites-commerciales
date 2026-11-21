// Test de bout en bout de l'application web, dans un navigateur au format téléphone.
// Prérequis : back démarré avec les données de démonstration (npm -w server run seed), application web construite.
// Usage : BASE_URL=http://127.0.0.1:3000 SHOTS=/dossier node e2e/web.cjs   (Playwright doit être installé)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const SHOTS = process.env.SHOTS;
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const status = () => page.getByText(/Synchronisé|Hors-ligne/).first().textContent();

  // 1. Connexion
  await page.goto(BASE);
  await page.getByLabel('E-mail').fill('commercial1@exemple.invalid');
  await page.getByLabel('Mot de passe').fill('demo-mot-de-passe-12');
  await shot(page, '1-connexion');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByText('Synchronisé').waitFor();

  // 2. Clients reçus du CRM, création d'une visite
  await page.getByRole('button', { name: 'Clients' }).click();
  await page.getByText('Dupont SA').waitFor();
  assert.ok(await page.getByText('Atelier Roux').isVisible());
  assert.equal(await page.getByText('Groupe Bernard').count(), 0, 'commercial1 ne voit pas le client de commercial2');
  await shot(page, '2-clients');
  await page.getByText('Dupont SA').click();
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await page.getByLabel('Nouvelle note').fill('M. Martin intéressé par l\'offre B');
  await page.getByRole('button', { name: 'Ajouter' }).click();
  await page.getByLabel('Résumé du compte rendu').fill('Intéressé par l\'offre B, budget à confirmer.');
  await page.getByRole('button', { name: 'Valider' }).click();
  await shot(page, '3-visite');

  // 3. Action
  await page.getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('button', { name: '+ Nouvelle' }).click();
  await page.getByLabel('Intitulé de l\'action').fill('Envoyer le devis');
  await page.getByLabel('Échéance').fill('2026-11-26');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByText('Envoyer le devis').waitFor();
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
  // rechargement de la page hors-ligne n'est pas testé (pas de service worker) ; l'état local doit survivre à un rechargement en ligne
  await ctx.setOffline(false);
  await page.getByText('Synchroniser').click();
  await page.getByText('Synchronisé').waitFor();
  assert.equal(/en attente/.test(await status()), false);

  // 5. Les données sont bien sur le serveur, et survivent à un rechargement
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

  assert.deepEqual(errors, [], 'aucune erreur JavaScript dans la page');
  await browser.close();
  console.log('E2E web : OK');
})().catch(e => { console.error('E2E web : ÉCHEC\n', e); process.exit(1); });
