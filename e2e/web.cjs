// Test de bout en bout de l'application web, dans un navigateur au format téléphone.
// Prérequis : back démarré avec les données de démonstration (npm -w server run seed), application web construite.
// DATABASE_URL (même base que le back) : le test vieillit quelques dates directement en base (retards impossibles à créer par l'application).
// Usage : DATABASE_URL=postgres://… BASE_URL=http://127.0.0.1:3000 SHOTS=/dossier node e2e/web.cjs   (Playwright doit être installé)
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const net = require('node:net');

// Faux serveur SMTP : reçoit les e-mails envoyés par le back (SMTP_HOST=127.0.0.1 SMTP_PORT=2525 côté back) sans rien envoyer pour de vrai.
const mails = [];
function startSmtpSink(port) {
  return new Promise(resolve => {
    const srv = net.createServer(sock => {
      let buf = '', data = false, cur = { to: [], raw: '' };
      const say = l => sock.write(l + '\r\n');
      say('220 sink ESMTP');
      sock.on('data', d => {
        buf += d.toString('utf8');
        for (;;) {
          if (data) {
            const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return;
            cur.raw = buf.slice(0, end); buf = buf.slice(end + 5); data = false; mails.push(cur); cur = { to: [], raw: '' }; say('250 ok'); continue;
          }
          const nl = buf.indexOf('\r\n'); if (nl < 0) return;
          const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
          if (/^EHLO|^HELO/i.test(line)) say('250 sink');
          else if (/^RCPT TO/i.test(line)) { cur.to.push(/<([^>]+)>/.exec(line)[1]); say('250 ok'); }
          else if (/^DATA/i.test(line)) { data = true; say('354 go'); }
          else if (/^QUIT/i.test(line)) { say('221 bye'); sock.end(); }
          else say('250 ok');
        }
      });
      sock.on('error', () => {});
    }).listen(port, '127.0.0.1', () => resolve(srv));
  });
}
// Décodage du corps (quoted-printable ou base64) pour chercher du texte dans le message reçu.
const mailText = m => { const raw = m.raw; const qp = raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const b64 = [...raw.matchAll(/\r\n\r\n([A-Za-z0-9+\/=\r\n]{40,})/g)].map(x => Buffer.from(x[1].replace(/\s/g, ''), 'base64').toString('utf8')).join('\n');
  return Buffer.from(qp, 'latin1').toString('utf8') + '\n' + b64; };
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
const newPhone = (browser, extra = {}) => browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'], ...extra });

(async () => {
  const smtp = await startSmtpSink(2525);
  // Faux micro du navigateur (un signal de test) : la vraie chaîne d'enregistrement et d'envoi est exercée, sans matériel.
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
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
  // Marque blanche : nom et logo de l'entreprise (BRAND_NAME / BRAND_LOGO_FILE côté back) sur la connexion, titre de la page, puis discrets dans l'application
  await page.getByRole('heading', { name: 'ACME Industrie' }).waitFor();
  const logo = page.getByRole('img', { name: 'Logo ACME Industrie' });
  await logo.waitFor();
  await page.waitForFunction(() => { const i = document.querySelector('img[alt="Logo ACME Industrie"]'); return i && i.complete && i.naturalWidth > 0; });
  assert.equal(await page.title(), 'ACME Industrie', 'titre de la page = nom de l\'entreprise');
  await shot(page, '1-connexion');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await page.getByText('Synchronisé').waitFor();
  assert.equal(await page.getByRole('img', { name: 'Logo ACME Industrie' }).count(), 1, 'logo discret en haut de la liste des visites');
  assert.equal(await page.getByText('ACME Industrie', { exact: true }).count(), 0, 'le nom n\'est pas répété à côté du logo');

  // 2. Clients reçus du CRM ; création d'une visite
  await page.getByRole('button', { name: 'Clients', exact: true }).click();
  await page.getByText('Dupont SA').waitFor();
  assert.ok(await page.getByText('Atelier Roux').isVisible());
  assert.equal(await page.getByText('Groupe Bernard').count(), 0, 'commercial1 ne voit pas le client de commercial2');
  await shot(page, '2-clients');
  await page.getByText('Dupont SA').click();
  // Fiche client : informations, visites précédentes, actions ; aucune visite n'est créée au simple clic
  await page.getByRole('heading', { name: 'Dupont SA' }).waitFor();
  await page.getByText(/^Visites \(/).waitFor();
  await page.getByText(/^Actions associées \(/).waitFor();
  assert.equal(await page.getByText('Statut', { exact: true }).count(), 0, 'on est sur la fiche client, pas sur une visite');
  await shot(page, '2b-fiche-client');
  await page.getByRole('button', { name: '+ Planifier une visite' }).click();
  await page.getByText('Statut', { exact: true }).waitFor();

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
  await page.getByLabel('Date et heure prévues', { exact: true }).fill('2026-12-01T14:37');   // pas de 15 minutes : 14:37 devient 14:30
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
  assert.equal(await page.getByRole('button', { name: 'Modifier l\'adresse de la visite' }).getByText('🔒').count(), 1, 'adresse non modifiable une fois la visite commencée (cadenas)');
  // date non modifiable une fois la visite commencée : cadenas ; la raison n'apparaît qu'au survol
  assert.equal(await page.getByRole('button', { name: 'Modifier la date prévue' }).getByText('🔒').count(), 1, 'cadenas sur la date');
  assert.equal(await page.getByText(/n'est plus modifiable une fois la visite commencée/).count(), 0, 'raison masquée tant qu\'on ne survole pas');
  await page.getByRole('button', { name: 'Modifier la date prévue' }).hover();
  await page.getByText('La date prévue n\'est plus modifiable une fois la visite commencée.').waitFor();
  await page.mouse.move(5, 400);
  assert.equal(await page.getByLabel('Nouvelle note', { exact: true }).count(), 0, 'plus de champ de note permanent : écran allégé');
  assert.ok(await page.getByText('Notes durant visite', { exact: true }).first().isVisible(), 'libellé « Notes durant visite »');
  assert.ok(await page.getByRole('button', { name: /🎤 Dicter une note/ }).isVisible(), 'icône micro sur le bouton dicter');
  await page.getByRole('button', { name: '+ Ajouter une note', exact: true }).click();
  await page.getByLabel('Nouvelle note', { exact: true }).fill('M. Martin intéressé par l\'offre B');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByText('M. Martin intéressé par l\'offre B').first().waitFor();

  // 2 sexies bis bis. Notes modifiables ; suppression avec confirmation ; notes internes (distinctes, partagées avec la hiérarchie)
  await page.getByRole('button', { name: 'Modifier la note', exact: true }).first().click();
  await page.getByLabel('Texte de la note', { exact: true }).fill('M. Martin intéressé par l\'offre B (corrigé)');
  await page.getByRole('button', { name: 'Enregistrer' }).last().click();
  await page.getByText('M. Martin intéressé par l\'offre B (corrigé)').first().waitFor();
  await page.getByRole('button', { name: '+ Ajouter une note', exact: true }).click();
  await page.getByLabel('Nouvelle note', { exact: true }).fill('À supprimer');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.locator('textarea[aria-label^="Nouvelle note"]').waitFor({ state: 'detached' });
  await page.getByText('À supprimer', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Modifier la note', exact: true }).last().click();
  await page.getByRole('button', { name: 'Supprimer la note' }).click();
  await page.getByText('Supprimer cette note ?').waitFor();                       // confirmation demandée
  assert.ok(await page.getByText('La suppression est définitive.').isVisible());
  await page.getByRole('button', { name: 'Annuler' }).last().click();               // annuler la confirmation : retour à l'édition, rien supprimé
  await page.getByLabel('Texte de la note', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Supprimer la note' }).click();
  await page.getByRole('button', { name: 'Confirmer la suppression' }).click();
  await page.getByText('Supprimer cette note ?').waitFor({ state: 'detached' });
  await page.getByText('À supprimer', { exact: true }).waitFor({ state: 'detached' });
  assert.ok(await page.getByText('Notes internes', { exact: true }).first().isVisible(), 'section « Notes internes » distincte');
  await page.getByRole('button', { name: '+ Ajouter une note interne' }).click();
  await page.getByLabel('Nouvelle note interne', { exact: true }).fill('Budget réel plus élevé, ne pas communiquer au client');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.locator('textarea[aria-label^="Nouvelle note"]').waitFor({ state: 'detached' });
  await page.getByText('Budget réel plus élevé, ne pas communiquer au client').waitFor();
  assert.ok(await page.getByText('Vous', { exact: true }).first().isVisible(), 'note interne signée');

  // 2 sexies ter. Dictée vocale (faux Voxtral) : enregistrement réel avec le faux micro, transcription à relire, note créée après relecture
  await page.getByRole('button', { name: 'Dicter une note' }).click();
  await page.getByRole('button', { name: /Arrêter la dictée/ }).waitFor();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /Arrêter la dictée/ }).click();
  await page.getByLabel('Texte dicté').waitFor();
  assert.equal(await page.getByLabel('Texte dicté').inputValue(), 'Dictée simulée : le client confirme un budget de 40 000 euros.');
  assert.equal(await page.getByText('Dictée simulée', { exact: false }).count() >= 1, true);
  await page.getByLabel('Texte dicté').fill('Dictée relue : le client confirme un budget de 40 000 euros.');
  await page.getByRole('button', { name: 'Ajouter la note' }).click();
  await page.getByText('Dictée relue : le client confirme un budget de 40 000 euros.').waitFor();
  const tr = await (await fetch('http://127.0.0.1:4010/__transcriptions')).json();
  assert.equal(tr.length, 1); assert.equal(tr[0].auth, 'Bearer cle-de-test');
  assert.match(tr[0].contentType, /^multipart\/form-data/); assert.ok(!tr[0].language, 'aucune langue imposée à la dictée : détection automatique');
  assert.equal(tr[0].fileType.trim(), 'audio/webm', 'format enregistré par le navigateur');
  assert.ok(tr[0].bytes > 1000, `audio reçu (${tr[0].bytes} octets)`);
  await shot(page, '3h-dictee');

  // 2 sexies bis. Écran dédié au compte rendu ; génération par IA (faux Mistral) : proposition à relire, avertissements, application, action créée
  assert.equal(await page.getByLabel('Résumé du compte rendu').count(), 0, 'le compte rendu n\'est plus sur l\'écran de visite');
  await page.getByRole('button', { name: 'Ouvrir le compte rendu' }).click();
  await page.getByRole('heading', { name: 'Compte rendu' }).waitFor();
  await page.goBack();                                                             // bouton retour du téléphone : revient à la visite
  await page.getByRole('heading', { name: 'Dupont SA' }).waitFor();
  await page.goForward();
  await page.getByRole('heading', { name: 'Compte rendu' }).waitFor();
  await page.getByRole('button', { name: /Générer \(IA\)/ }).click();
  await page.getByText('Proposition de l\'IA').waitFor();
  assert.ok(await page.getByText('Nombre absent des notes : 50000', { exact: false }).first().isVisible(), 'nombre qui ne figure pas dans les notes : signalé');
  assert.ok(await page.getByText(/Échéance calculée à partir d'une date relative/).first().isVisible(), 'échéance relative signalée');
  assert.equal(await page.getByLabel('Proposition : Résumé').inputValue(), 'M. Martin est intéressé par l\'offre B (réponse simulée).');
  await page.waitForTimeout(500);   // fin de l'animation d'ouverture avant la capture
  await shot(page, '3g-proposition-ia');
  assert.equal((await page.getByLabel('Résumé du compte rendu').inputValue()), '', 'rien n\'est appliqué avant la validation de la proposition');
  await page.getByRole('button', { name: 'Appliquer au compte rendu' }).click();
  await page.getByText('Proposition de l\'IA').waitFor({ state: 'detached' });
  assert.match(await page.getByLabel('Résumé du compte rendu').inputValue(), /offre B \(réponse simulée\)/, 'résumé appliqué');
  assert.match(await page.getByRole('textbox', { name: 'Besoins', exact: true }).inputValue(), /atelier/, 'champs détaillés appliqués');
  const sent = await (await fetch('http://127.0.0.1:4010/__requests')).json();
  assert.equal(sent.length, 1); assert.equal(sent[0].auth, 'Bearer cle-de-test');
  assert.ok(sent[0].body.messages[1].content.includes('M. Martin intéressé par l\'offre B (corrigé)'), 'les notes (corrigées) sont envoyées');
  assert.ok(!sent[0].body.messages[1].content.includes('Budget réel plus élevé'), 'les notes internes ne sont JAMAIS envoyées à l\'IA');
  assert.ok(!sent[0].body.messages[1].content.includes('À supprimer'), 'une note supprimée n\'est pas envoyée');
  assert.ok(sent[0].body.messages[1].content.includes('Dictée relue'), 'la note dictée (relue) est incluse dans la synthèse');
  assert.ok(!JSON.stringify(sent[0].body).includes('Dupont'), 'le nom du client n\'est pas envoyé');
  // Dictée directement dans un champ du compte rendu (micro à côté du libellé) : le texte est ajouté à la fin du champ
  const besoinsAvant = await page.getByLabel('Besoins', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Dicter : Besoins', exact: true }).click();
  await page.getByRole('button', { name: 'Arrêter la dictée' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Dicter : Décisions', exact: true }).isDisabled(), true, 'un seul enregistrement à la fois');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Arrêter la dictée' }).click();
  await page.waitForFunction(() => /Dictée simulée/.test(document.querySelector('[aria-label="Besoins"]').value));
  const besoinsApres = await page.getByLabel('Besoins', { exact: true }).inputValue();
  assert.equal(besoinsApres, `${besoinsAvant} Dictée simulée : le client confirme un budget de 40 000 euros.`, 'texte ajouté à la suite du champ, sans écraser');
  await page.getByLabel('Besoins', { exact: true }).fill(besoinsAvant);
  // Les actions proposées par la génération sont seulement « prévues » dans le brouillon : pas encore de vraies actions
  await page.getByText('Préparer la démo').waitFor();
  await page.getByText('Rappeler M. Martin').waitFor();
  assert.ok(await page.getByText('Elles ne deviennent de vraies actions que lorsque le compte rendu est validé.').isVisible());
  await page.getByLabel('Résumé du compte rendu').fill('Intéressé par l\'offre B, budget à confirmer.');
  // validation du compte rendu impossible tant que la visite n'est pas terminée
  assert.equal(await page.getByRole('button', { name: 'Valider le compte rendu' }).getAttribute('data-testid'), 'disabled-hint', 'validation refusée visite en cours');
  assert.equal(await page.getByText(/^Pour valider/).count(), 0, 'la raison n\'est pas affichée en permanence');
  await page.getByRole('button', { name: 'Valider le compte rendu' }).hover();                    // infobulle au survol
  await page.getByText('Pour valider : terminez le rendez-vous (« Fin du rendez-vous » sur la visite).').waitFor();
  await page.mouse.move(5, 300);
  await shot(page, '3k-cr-brouillon');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByRole('button', { name: '‹ Retour' }).click();
  await page.getByRole('heading', { name: 'Dupont SA' }).waitFor();
  await page.getByText('Aucune action pour cette visite.').waitFor();
  await page.getByText('2 actions prévues : créées à la validation du compte rendu.').waitFor();

  // Fin de visite : les notes durant visite ne sont plus modifiables (les notes internes, si) ; terminer ne crée aucune action
  await page.getByRole('button', { name: 'Fin du rendez-vous' }).click();
  // sections repliées d'office une fois le rendez-vous terminé : le résumé dit combien de notes, un clic les déplie
  await page.getByRole('button', { name: /Notes durant visite/ }).click();
  assert.equal(await page.getByText('Le rendez-vous est terminé : les notes durant visite ne sont plus modifiables.').count(), 0, 'raison masquée sans survol');
  await page.getByRole('button', { name: '+ Ajouter une note', exact: true }).hover();
  await page.getByText('Le rendez-vous est terminé : les notes durant visite ne sont plus modifiables.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Modifier la note', exact: true }).count(), 0, 'plus de modification de note');
  assert.equal(await page.getByRole('button', { name: '+ Ajouter une note', exact: true }).getAttribute('data-testid'), 'disabled-hint', 'plus d\'ajout de note');
  assert.equal(await page.getByRole('button', { name: /Dicter une note/ }).count(), 0, 'plus de dictée de note');
  await page.getByRole('button', { name: /Notes internes/ }).click();
  assert.ok(await page.getByRole('button', { name: '+ Ajouter une note interne' }).isVisible(), 'notes internes : toujours possibles');
  assert.equal(await page.getByText('Aucune action pour cette visite.').count(), 1, 'terminer la visite ne crée aucune action');
  assert.ok(await page.getByText('Effectuée', { exact: true }).first().isVisible(), 'rendez-vous fini : visite « Effectuée », pas « Terminée »');

  // Validation du compte rendu : crée les actions prévues, passe la visite à « CR validé », verrouille le compte rendu
  await page.getByRole('button', { name: 'Ouvrir le compte rendu' }).click();
  await page.getByRole('button', { name: 'Valider le compte rendu' }).click();
  await page.getByText('Compte rendu validé : les actions ont été créées.').waitFor();
  assert.equal(await page.getByLabel('Résumé du compte rendu').isEditable(), false, 'compte rendu validé : champs verrouillés');
  assert.equal(await page.getByRole('button', { name: 'Valider le compte rendu' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^Dicter : / }).count(), 0, 'plus de dictée dans un compte rendu validé');
  await page.getByText('2 à faire · 0 terminée').waitFor();                      // actions créées par le serveur, reçues à la synchro
  await shot(page, '3c-compte-rendu-valide');
  await page.getByRole('button', { name: '‹ Retour' }).click();
  await page.getByText('CR validé', { exact: true }).first().waitFor();
  await page.getByText('2 à faire · 0 terminée').waitFor();

  // Envoi par e-mail : à soi et au manager ; compte rendu, actions, notes durant visite ; jamais les notes internes
  await page.getByRole('button', { name: 'Envoyer par e-mail' }).click();
  await page.getByText('Moi (commercial1@exemple.invalid)').waitFor();
  assert.equal(await page.getByRole('checkbox', { name: 'Compte rendu' }).getByText('✓').count(), 1, 'compte rendu validé : proposé par défaut')
  await page.getByRole('checkbox', { name: /Manager Démo/ }).click();
  await page.getByLabel('Message de l\'e-mail', { exact: true }).fill('Pour info avant le point d\'équipe');
  await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await page.getByText(/E-mail envoyé à commercial1@exemple.invalid, manager@exemple.invalid/).waitFor();
  await shot(page, '3j-email-envoye');
  await page.getByRole('button', { name: 'Fermer', exact: true }).last().click();
  assert.equal(mails.length, 1, 'un e-mail reçu par le serveur SMTP');
  assert.deepEqual(mails[0].to.sort(), ['commercial1@exemple.invalid', 'manager@exemple.invalid']);
  const body = mailText(mails[0]);
  for (const t of ['Intéressé par l\'offre B', 'Préparer la démo', 'Dictée relue', 'Pour info avant le point d\'équipe', 'Envoyé depuis ACME Industrie']) assert.ok(body.includes(t), `l'e-mail contient : ${t}`);
  assert.ok(!body.includes('Budget réel plus élevé'), 'les notes internes ne sont jamais envoyées par e-mail');
  {       // suivi d'équipe : le manager voit les actions en retard de ses commerciaux
    await page.getByRole('button', { name: 'Synchroniser' }).click(); await page.getByText('Synchronisé').waitFor();
    execFileSync('psql', [process.env.DATABASE_URL, '-c', "UPDATE action_item SET due_date = current_date - 3 WHERE title = 'Préparer la démo'"]);
    const tctx = await newPhone(browser); const tp = await tctx.newPage(); tp.on('pageerror', e => errors.push(e.message));
    await login(tp, 'manager@exemple.invalid');
    await tp.getByRole('button', { name: 'Actions', exact: true }).click();
    await tp.getByLabel('Actions de l\'équipe').waitFor();
    await tp.getByText('Équipe · 1 action en retard').waitFor();
    await tp.getByText('1 en retard · 2 à faire').waitFor();
    await tctx.close();
    execFileSync('psql', [process.env.DATABASE_URL, '-c', "UPDATE action_item SET due_date = current_date + 10 WHERE title = 'Préparer la démo'"]);   // la suite attend une seule action en retard
    await page.getByRole('button', { name: 'Synchroniser' }).click(); await page.getByText('Synchronisé').waitFor();
  }

  // Actions de la visite : lien avec compteur ; accès à la visite depuis une action ; plus de création depuis la vue Actions
  await page.getByRole('button', { name: 'Voir les actions de la visite' }).click();
  await page.getByText('Actions de la visite · Dupont SA').waitFor();
  await page.getByText('Préparer la démo').waitFor();
  assert.equal(await page.getByRole('button', { name: '+ Nouvelle' }).count(), 0, 'plus de création d\'action depuis la vue Actions');
  await page.getByRole('link', { name: /Voir la visite de l'action : Préparer la démo/ }).click();
  await page.getByRole('heading', { name: 'Dupont SA' }).waitFor();
  await page.goBack();                                                             // retour du téléphone : revient aux actions de la visite
  await page.getByText('Actions de la visite · Dupont SA').waitFor();
  await page.getByRole('button', { name: 'Ouvrir la visite', exact: true }).click();
  await page.getByRole('heading', { name: 'Dupont SA' }).waitFor();

  // Ajout manuel depuis la visite (compte rendu validé : l'action est créée tout de suite)
  await page.getByRole('button', { name: '+ Ajouter une action' }).click();
  await page.getByText('Le compte rendu est validé : l\'action est créée tout de suite.').waitFor();
  await page.getByLabel('Intitulé de l\'action').fill('Envoyer le devis');
  assert.equal(await page.getByLabel('Échéance de l\'action').getAttribute('type'), 'date', 'sélecteur natif de date');
  await page.getByLabel('Échéance de l\'action').fill('2026-11-26');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByText('3 à faire · 0 terminée').waitFor();
  await page.getByRole('button', { name: '+ Ajouter une action' }).click();
  await page.getByLabel('Intitulé de l\'action').fill('Relancer le client (en retard)');
  await page.getByLabel('Échéance de l\'action').fill(daysAgo(5));                  // échéance antérieure à la visite : refusée
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).hover();           // la raison n'apparaît qu'au survol du bouton grisé
  await page.getByText('L\'échéance est antérieure à la date de la visite.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Enregistrer', exact: true }).getAttribute('data-testid'), 'disabled-hint', 'enregistrement bloqué');
  await page.getByLabel('Échéance de l\'action').fill('2026-12-15');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await page.getByText('4 à faire · 0 terminée').waitFor();
  // L'application interdit une échéance antérieure à la visite ; pour obtenir une action en retard, on vieillit son échéance en base.
  execFileSync('psql', [process.env.DATABASE_URL, '-c', `UPDATE action_item SET due_date = '${daysAgo(5)}' WHERE title = 'Relancer le client (en retard)'`]);
  await page.getByRole('button', { name: 'Synchroniser' }).click(); await page.getByText('Synchronisé').waitFor();
  await shot(page, '3c-terminee');

  // Une visite validée ne disparaît pas de la liste tant qu'il reste des actions à faire
  await page.getByRole('button', { name: 'Visites', exact: true }).click();
  await page.getByText('4 actions à faire').waitFor();
  assert.equal(await page.getByText('Aucune visite à afficher.').count(), 0, 'visite validée avec actions à faire : toujours affichée');
  await page.getByText(/^Réalisée /).waitFor();
  assert.ok(await page.getByText(/^Prévue .*déc/).first().isVisible(), 'la date prévue reste affichée sous la date réalisée');
  await shot(page, '3d-visites-par-client');
  await page.getByRole('radio', { name: 'Par date' }).click();
  await page.getByText('Dupont SA', { exact: true }).first().waitFor();
  await page.getByRole('radio', { name: 'Par client' }).click();

  // Vue Actions : échéance en clair, action en retard identifiable, lien vers la visite
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByText('Relancer le client (en retard)').waitFor();
  assert.ok(await page.getByText(/jeu\.? 26 nov\.? 2026/).first().isVisible(), 'échéance affichée en clair, pas en AAAA-MM-JJ');
  assert.equal(await page.getByText('En retard', { exact: true }).count(), 1, 'seule l\'action dont l\'échéance est passée est signalée en retard');
  assert.equal(await borderOf(page.getByText('En retard', { exact: true })), 'rgb(198, 40, 40)', 'pastille « En retard » en rouge');
  await shot(page, '4-actions');

  // Hors-ligne : terminer une action localement, file en attente, puis reconnexion
  await ctx.setOffline(true);
  await page.getByRole('checkbox').first().click();                                // « Relancer le client (en retard) »
  await page.getByText('Synchroniser').click();
  await page.getByText(/Hors-ligne.*en attente/).waitFor();
  await shot(page, '5-hors-ligne');
  await ctx.setOffline(false);
  await page.getByText('Synchroniser').click();
  await page.getByText('Synchronisé').waitFor();
  assert.equal(/en attente/.test(await status()), false);

  // Les données survivent à un rechargement ; les actions terminées sont masquées par défaut
  await page.reload();
  await page.getByText('Synchronisé').waitFor();
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByText('Envoyer le devis').waitFor();
  await page.getByText('1 action(s) terminée(s) ou annulée(s) masquée(s).').waitFor();
  assert.equal(await page.getByText('Relancer le client (en retard)').count(), 0, 'l\'action terminée disparaît de la liste');
  await page.getByRole('switch', { name: 'Afficher les actions terminées ou annulées' }).click();
  await page.getByText('Relancer le client (en retard)').waitFor();
  await page.getByRole('switch', { name: 'Afficher les actions terminées ou annulées' }).click();

  // Terminer toutes les actions : la visite validée disparaît alors de la liste (masquée par défaut)
  for (let i = 0; i < 3; i++) { await page.getByRole('checkbox').first().click(); }
  await page.getByText('Aucune action à afficher.', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Visites', exact: true }).click();
  await page.getByText('Aucune visite à afficher.').waitFor();
  await page.getByText('1 visite terminée masquée.').waitFor();
  await page.getByRole('switch', { name: 'Afficher les visites terminées' }).click();
  await page.getByText('1 visite', { exact: true }).waitFor();
  await page.getByText('Terminée', { exact: true }).first().waitFor();       // compte rendu validé et toutes les actions faites : « Terminée »

  // Compte rendu validé : verrouillé ; remise en brouillon avec confirmation ; la visite redevient « Effectuée »
  await page.getByText(/^Réalisée /).click();
  await page.getByRole('heading', { name: 'Dupont SA' }).waitFor();
  await page.getByRole('button', { name: 'Ouvrir le compte rendu' }).click();
  await page.getByRole('button', { name: 'Remettre en brouillon' }).click();
  await page.getByText('Remettre le compte rendu en brouillon ?').waitFor();
  await page.getByRole('button', { name: 'Annuler' }).last().click();                // annuler : rien ne change
  await page.getByText('Remettre le compte rendu en brouillon ?').waitFor({ state: 'detached' });
  assert.equal(await page.getByLabel('Résumé du compte rendu').isEditable(), false, 'toujours verrouillé');
  await page.getByRole('button', { name: 'Remettre en brouillon' }).click();
  await page.getByRole('button', { name: 'Remettre en brouillon' }).last().click();  // confirmer
  await page.getByRole('button', { name: 'Valider le compte rendu' }).waitFor();
  assert.equal(await page.getByLabel('Résumé du compte rendu').isEditable(), true, 'brouillon : modifiable de nouveau');
  await page.getByRole('button', { name: '‹ Retour' }).click();
  await page.getByText('Effectuée', { exact: true }).first().waitFor();                // la visite est repassée à « Effectuée »
  assert.equal(await page.getByText('CR validé', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Ouvrir le compte rendu' }).click();
  await page.getByRole('button', { name: 'Valider le compte rendu' }).click();       // nouvelle validation : pas de doublon d'actions
  await page.getByText('Compte rendu validé : les actions ont été créées.').waitFor();
  await page.getByText('0 à faire · 4 terminées').waitFor();

  // Déconnexion qui efface les données de l'appareil
  await page.getByRole('button', { name: 'Réglages', exact: true }).click();
  await page.getByRole('button', { name: /Se déconnecter/ }).click();
  await page.getByRole('button', { name: 'Se connecter' }).waitFor();
  const left = await page.evaluate(() => [localStorage.getItem('visites.store.v1'), localStorage.getItem('visites.session.v1')]);
  assert.deepEqual(left, [null, null], 'rien ne doit rester sur l\'appareil après la déconnexion');

  // 7. Droits : un manager voit la visite d'un commercial « à organiser » et peut corriger l'adresse, pas la date
  const c1 = await newPhone(browser); const p1 = await c1.newPage();
  p1.on('pageerror', e => errors.push(e.message));
  await login(p1, 'commercial1@exemple.invalid');
  await p1.getByRole('button', { name: 'Clients', exact: true }).click();
  await p1.getByText('Atelier Roux').click();
  await p1.getByRole('button', { name: '+ Planifier une visite' }).click();
  await p1.getByText('À organiser', { exact: true }).first().waitFor();
  await p1.getByText('Le compte rendu sera disponible une fois la visite commencée.').waitFor();
  await p1.getByRole('button', { name: '+ Ajouter une note interne' }).click();
  await p1.getByLabel('Nouvelle note interne', { exact: true }).fill('Le client hésite, voir avec la direction');
  await p1.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await p1.locator('textarea[aria-label^="Nouvelle note"]').waitFor({ state: 'detached' });
  await p1.getByText('Le client hésite, voir avec la direction').waitFor();
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
  assert.equal(await mp.getByRole('button', { name: 'Modifier la date prévue' }).getByText('🔒').count(), 1, 'le manager ne modifie pas la date (cadenas)');
  await mp.getByText('Le client hésite, voir avec la direction').waitFor();                      // note interne : partagée avec la hiérarchie
  await mp.getByText('Commercial Un', { exact: true }).waitFor();
  assert.equal(await mp.getByRole('button', { name: 'Modifier la note interne' }).count(), 0, 'le manager lit la note interne sans pouvoir la modifier');
  assert.equal(await mp.getByRole('button', { name: '+ Ajouter une note interne' }).getAttribute('data-testid'), 'disabled-hint', 'le manager n\'écrit pas de note interne');
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
  assert.equal(await mp.getByRole('button', { name: 'Modifier l\'adresse de la visite' }).count(), 0, 'liste des visites : pas de bouton de modification');
  // 7 ter. Suppression d'une visite : le manager ne peut pas ; le commercial confirme ; elle est masquée par défaut
  await mp.getByText('Organisée', { exact: true }).first().click();
  await mp.getByText('Statut', { exact: true }).waitFor();
  assert.equal(await mp.getByRole('button', { name: 'Supprimer la visite' }).getAttribute('data-testid'), 'disabled-hint', 'le manager ne supprime pas une visite');
  await mp.getByRole('button', { name: 'Supprimer la visite' }).hover();
  await mp.getByText(/réservée au visiteur auteur de la visite et au directeur/).waitFor();
  await mp.getByRole('button', { name: '‹ Retour' }).click();
  await p1.getByRole('button', { name: 'Supprimer la visite' }).click();
  await p1.getByText('Supprimer cette visite ?').waitFor();                 // confirmation demandée
  await p1.getByRole('button', { name: 'Annuler', exact: true }).last().click();
  await p1.getByText('Supprimer cette visite ?').waitFor({ state: 'detached' });
  assert.equal(await p1.getByText('Organisée', { exact: true }).count() > 0, true, 'annuler ne supprime rien');
  await p1.getByRole('button', { name: 'Supprimer la visite' }).click();
  await p1.getByRole('button', { name: 'Supprimer la visite' }).last().click();
  await p1.getByText('Supprimer cette visite ?').waitFor({ state: 'detached' });
  await p1.getByText(/visite supprimée masquée/).waitFor();                  // retour sur la fiche client : visite masquée
  await shot(p1, '3g-visite-supprimee-masquee');
  await p1.getByRole('button', { name: 'Visites', exact: true }).click();
  await p1.getByText('Supprimée', { exact: true }).waitFor({ state: 'detached' }).catch(() => {});
  await p1.getByRole('switch', { name: 'Afficher les visites supprimées' }).click();
  await p1.getByText('Supprimée', { exact: true }).first().waitFor();
  await p1.getByText('Supprimée', { exact: true }).first().click();
  await p1.getByText('Cette visite est supprimée').waitFor();
  assert.equal(await p1.getByRole('button', { name: 'Modifier la date prévue' }).count(), 0, 'visite supprimée : plus modifiable');
  assert.equal(await p1.getByRole('button', { name: 'Supprimer la visite' }).count(), 0, 'déjà supprimée');
  await shot(p1, '3h-visite-supprimee');
  await p1.getByRole('button', { name: 'Synchroniser' }).click();
  await p1.getByText('Synchronisé').waitFor();
  for (let i = 0; i < 8 && await mp.getByText('Organisée', { exact: true }).count() > 0; i++) {      // le push du commercial peut ne pas être terminé : on relit
    await mp.waitForTimeout(500); await mp.getByRole('button', { name: 'Synchroniser' }).click(); await mp.getByText('Synchronisé').waitFor();
  }
  assert.equal(await mp.getByText('Atelier Roux').count(), 0, 'le manager ne voit plus la visite supprimée (masquée par défaut)');
  await c1.close(); await mctx.close();

  // 7 bis. Page en HTTP sur le réseau local : pas de micro du navigateur (contexte non sécurisé) -> repli par choix d'un fichier audio
  const nctx = await newPhone(browser); await nctx.addInitScript(() => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); });
  const np = await nctx.newPage(); np.on('pageerror', e => errors.push(e.message));
  await login(np, 'commercial1@exemple.invalid');
  await np.getByRole('button', { name: 'Clients', exact: true }).click();         // la visite précédente est supprimée : on en planifie une nouvelle
  await np.getByText('Atelier Roux').click();
  await np.getByRole('button', { name: '+ Planifier une visite' }).click();
  await np.getByText(/Le micro du navigateur demande une connexion sécurisée/).waitFor();
  assert.equal(await np.getByRole('button', { name: 'Dicter une note' }).count(), 0, 'pas de bouton micro sans contexte sécurisé');
  await np.getByLabel('Fichier audio', { exact: true }).setInputFiles({ name: 'dictee.webm', mimeType: 'audio/webm', buffer: Buffer.alloc(3000, 5) });
  await np.getByLabel('Texte dicté').waitFor();
  assert.match(await np.getByLabel('Texte dicté').inputValue(), /Dictée simulée/);
  assert.equal((await (await fetch('http://127.0.0.1:4010/__transcriptions')).json()).length, 3, 'le fichier choisi est transcrit');
  await np.getByRole('button', { name: 'Annuler' }).click();
  // même repli sur l'écran du compte rendu (visite démarrée pour y accéder)
  await np.getByRole('button', { name: 'Démarrer la visite' }).click();
  await np.getByText('En cours', { exact: true }).first().waitFor();
  await np.getByRole('button', { name: 'Ouvrir le compte rendu' }).click();
  await np.getByRole('heading', { name: 'Compte rendu' }).waitFor();
  // même repli pour un champ du compte rendu : icône micro qui ouvre le choix du fichier, texte ajouté au champ
  await np.getByLabel('Fichier audio : Objections', { exact: true }).setInputFiles({ name: 'dictee.webm', mimeType: 'audio/webm', buffer: Buffer.alloc(3000, 5) });
  await np.waitForFunction(() => /Dictée simulée/.test(document.querySelector('[aria-label="Objections"]').value));

  // 7 quater. Fin de rendez-vous sans note : confirmation ; compte rendu en retard signalé ; « aucune action à prévoir » ; historique ; visite « Terminée »
  await np.getByRole('button', { name: '‹ Retour' }).click();
  await np.getByRole('button', { name: 'Fin du rendez-vous' }).click();
  await np.getByText('Terminer le rendez-vous sans note ?').waitFor();
  await np.getByRole('button', { name: 'Annuler', exact: true }).last().click();
  await np.getByText('Terminer le rendez-vous sans note ?').waitFor({ state: 'detached' });
  await np.getByText('En cours', { exact: true }).first().waitFor();
  await np.getByRole('button', { name: 'Fin du rendez-vous' }).click();
  await np.getByRole('button', { name: 'Fin du rendez-vous' }).last().click();
  await np.getByText('Effectuée', { exact: true }).first().waitFor();
  {       // vieillit la fin du rendez-vous pour voir l'alerte « compte rendu à valider »
    await np.getByRole('button', { name: 'Synchroniser' }).click(); await np.getByText('Synchronisé').waitFor();
    execFileSync('psql', [process.env.DATABASE_URL, '-c', "UPDATE visit SET started_at = now() - interval '5 days 1 hour', ended_at = now() - interval '5 days' WHERE status = 'done'"]);
    await np.getByRole('button', { name: 'Synchroniser' }).click();
    await np.getByText('CR à valider', { exact: true }).first().waitFor();
    await np.getByRole('button', { name: 'Visites', exact: true }).click();
    await np.getByText(/compte rendu à valider depuis plus de 2 jours/).waitFor();
    await shot(np, '3i-cr-en-retard');
    await np.getByText('CR à valider', { exact: true }).first().click();
  }
  await np.getByRole('button', { name: 'Ouvrir le compte rendu' }).click();
  await np.getByLabel('Résumé du compte rendu').fill('Visite sans suite immédiate.');
  // dictée aussi dans la fenêtre d'ajout d'une action (tous les champs de saisie proposent le micro) ; repli par fichier audio sur cette page en HTTP
  await np.getByRole('button', { name: '+ Ajouter une action' }).click();
  await np.getByLabel('Fichier audio : Intitulé', { exact: true }).setInputFiles({ name: 'dictee.webm', mimeType: 'audio/webm', buffer: Buffer.alloc(3000, 5) });
  await np.waitForFunction(() => /Dictée simulée/.test(document.querySelector('[aria-label="Intitulé de l\'action"]').value));
  assert.equal((await (await fetch('http://127.0.0.1:4010/__transcriptions')).json()).length, 5, 'la dictée du champ « Intitulé » est transcrite');
  await np.getByRole('button', { name: 'Annuler', exact: true }).last().click();
  assert.equal(await np.getByRole('button', { name: 'Valider le compte rendu' }).getAttribute('data-testid'), 'disabled-hint', 'sans action ni case cochée : validation refusée');
  await np.getByRole('button', { name: 'Valider le compte rendu' }).hover();
  await np.getByText('Pour valider : ajoutez une action ou cochez « Aucune action à prévoir ».').waitFor();
  await np.getByRole('checkbox', { name: 'Aucune action à prévoir' }).click();
  await np.getByRole('button', { name: 'Valider le compte rendu' }).click();
  await np.getByText('Compte rendu validé : les actions ont été créées.').waitFor();
  await np.getByRole('button', { name: '‹ Retour' }).click();
  await np.getByText('Terminée', { exact: true }).first().waitFor();                  // aucun action à faire : « Terminée »
  assert.equal(await np.getByText('CR à valider', { exact: true }).count(), 0, 'plus d\'alerte une fois validé');
  await np.getByRole('button', { name: /Historique des modifications/ }).click();
  await np.getByText('Compte rendu validé', { exact: true }).waitFor();
  await np.getByRole('button', { name: 'Fermer' }).last().click();
  await nctx.close();

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
  await dp.getByRole('button', { name: 'Réglages', exact: true }).click();
  await dp.getByRole('radio', { name: 'Clair' }).click();
  await dp.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(244, 246, 245)');
  await dp.reload();
  await dp.getByText('Synchronisé').waitFor();
  assert.equal(await bg(dp), 'rgb(244, 246, 245)', 'le choix « Clair » survit au rechargement');
  await dp.getByRole('button', { name: 'Réglages', exact: true }).click();
  await dp.getByRole('radio', { name: 'Système' }).click();
  await dp.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(12, 19, 23)');
  await dp.getByRole('radio', { name: 'Sombre' }).click();
  await dp.getByRole('button', { name: /Se déconnecter/ }).click();
  await dp.getByRole('button', { name: 'Se connecter' }).waitFor();
  assert.equal(await bg(dp), 'rgb(12, 19, 23)', 'le réglage d\'affichage est conservé après la déconnexion');
  await dctx.close();

  assert.deepEqual(errors, [], 'aucune erreur JavaScript dans la page');
  await browser.close(); smtp.close();
  console.log('E2E web : OK');
})().catch(e => { console.error('E2E web : ÉCHEC\n', e); process.exit(1); });
