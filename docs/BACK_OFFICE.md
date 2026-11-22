# Application back (PC)

Application web pour ordinateur, servie par le back sur **`/admin/`** (sous un sous-chemin : `https://exemple.fr/visit/admin/`). Elle utilise la même authentification que l'application mobile et sa propre API, **`/api/back/v1`**. Dans ce prototype, elle tient aussi lieu de **maquette du CRM**.

## Rubriques et droits

| Rubrique | Qui | Contenu |
|---|---|---|
| Reporting | tous, selon le périmètre | indicateurs d'activité, par commercial, par semaine, comptes rendus en retard, export CSV |
| Préparation | tous, selon le périmètre | clients à visiter, fiche de préparation, planification pour un commercial, planning |
| Visites | tous, selon le périmètre | liste filtrée, détail (compte rendu, actions, notes durant visite, historique, e-mails envoyés) |
| Comptes | administrateurs | création, modification, désactivation, mot de passe, hiérarchie, mode de visibilité des comptes rendus |
| Clients (maquette CRM) | administrateurs | clients, contacts, affectations, import CSV |

**Périmètre** : un commercial voit ce qui le concerne ; un manager ou un directeur, lui-même et ses subordonnés (hiérarchie) ; un administrateur, tout. Pour la consultation des visites, les règles de visibilité des comptes rendus (mode 1 ou 2) s'appliquent en plus, sauf pour l'administrateur. **Les notes internes et privées ne sont jamais exposées.**

## Reporting

Période au choix (30 jours par défaut ; 800 jours au plus). Dates en UTC (AAAA-MM-JJ). Date de référence d'une visite : fin du rendez-vous, sinon début, sinon date prévue.

- Visites : prévues (à organiser ou organisées), en cours, effectuées (`done` + `validated`), annulées.
- Comptes rendus : validés, à valider, en retard (plus de 2 jours après la fin du rendez-vous), délai moyen de validation.
- Actions : à faire (toutes périodes), en retard, terminées sur la période.
- Clients du périmètre : visités sur la période, sans visite depuis 90 jours.
- Export CSV (séparateur « ; », UTF-8 avec BOM pour Excel ; les cellules qui commenceraient par `=`, `+`, `-` ou `@` sont neutralisées contre l'injection de formule).

Limites : les visites supprimées sont exclues ; une visite est comptée dans la période de sa date de référence ; aucun reporting financier ni objectif chiffré (non définis).

## Préparation des visites

- **Clients à visiter** : clients actifs affectés au périmètre, avec les motifs *jamais visité*, *sans visite depuis N jours* (30, 60, 90, 180), *actions en retard*, *opportunité chaude* (dernier compte rendu validé) *sans visite prévue*. Classés par priorité. Un client qui a déjà une visite à venir n'est pas proposé (case pour l'inclure).
- **Fiche de préparation** : informations et contacts, commerciaux, dernières visites avec leur compte rendu (si les droits le permettent), actions ouvertes, et des **points à aborder** déduits (prochaine étape, objections, décisions du dernier compte rendu, actions ouvertes).
- **Planifier** : un manager, un directeur ou un administrateur planifie pour un commercial de son périmètre auquel le client est affecté ; un commercial planifie pour lui-même. Champs : date et heure, adresse (par défaut celle du client), objectif, points à aborder. La visite est créée « à organiser » au nom du commercial (`created_by` = la personne qui planifie) et **arrive dans l'application mobile à la synchronisation suivante**, où le commercial voit l'objectif, les points à aborder et « Planifiée par … ».
- **Modifier** : date, adresse, objectif, points à aborder, passage à « organisée » ou « annulée », tant que la visite n'est pas commencée. Les changements de date et d'adresse sont inscrits à l'historique avec le nom de l'auteur du changement.

Limite connue : une modification faite depuis l'application back n'est pas comparée aux modifications concurrentes de l'application mobile (pas de détection de conflit pour ces deux champs) ; la dernière écriture l'emporte.

## Comptes (administrateurs)

Création avec mot de passe temporaire généré (16 caractères, affiché **une seule fois**, jamais journalisé) ou saisi (12 caractères minimum) ; modification du nom, du rôle, du supérieur, de la langue de dictée, du plafond IA mensuel ; désactivation (révoque jetons et appareils) ; réinitialisation du mot de passe (révoque les jetons). Garde-fous : pas d'auto-désactivation ni de retrait de ses propres droits d'administrateur ; pas de cycle hiérarchique ; le supérieur doit être manager ou directeur ; un manager qui a des subordonnés ne devient pas commercial. Les actions sensibles sont inscrites dans le journal d'audit (`audit_log`, sans mot de passe).

Non fait : double authentification, changement de mot de passe obligatoire à la première connexion, invitation par e-mail.

## Maquette du CRM (administrateurs)

Les clients, contacts et affectations saisis ou importés alimentent **les mêmes tables que l'import du vrai CRM** : les applications mobiles les reçoivent par la synchronisation, avec retrait d'accès en cas de désaffectation. Les clients créés ici ont un identifiant CRM `MAQ-…`.

**Import CSV** (séparateur « ; » ou « , », UTF-8) :
- clients : `crm_id;name;address_line;postal_code;city;country;sector;sales_emails` (`sales_emails` : adresses des commerciaux séparées par espace, virgule, point-virgule ou barre) ;
- contacts : `company_crm_id;crm_id;full_name;job_title;phone;email` (`crm_id` facultatif).

« Vérifier » contrôle sans rien écrire. Une erreur de format (colonne absente, identifiant manquant ou en double, client inconnu, e-mail invalide) **bloque tout l'import** ; une adresse de commercial inconnue n'est qu'un avertissement. Un client déjà connu est mis à jour ; ses commerciaux du fichier remplacent les affectations issues du CRM (les affectations saisies à la main dans la maquette sont conservées). Les clients absents du fichier ne sont pas désactivés.

## API `/api/back/v1`

Authentification : jeton de l'application mobile (`POST /api/mobile/v1/auth/login`, plateforme `web`).

| Méthode et chemin | Droits |
|---|---|
| `GET /me` | connecté |
| `GET /reports/activity`, `GET /reports/activity.csv` (`from`, `to`, `user_id`) | connecté, périmètre |
| `GET /prep/commerciaux`, `GET /prep/companies?q=`, `GET /prep/suggestions` (`days`, `user_id`, `include_planned`), `GET /prep/companies/{id}`, `GET /prep/visits` | connecté, périmètre |
| `POST /prep/visits`, `PATCH /prep/visits/{id}` | connecté, périmètre (voir ci-dessus) |
| `GET /visits`, `GET /visits/{id}` | connecté, périmètre et visibilité |
| `GET/POST /users`, `PATCH /users/{id}`, `POST /users/{id}/reset-password`, `GET/PUT /settings` | administrateur |
| `GET/POST /companies`, `GET/PATCH /companies/{id}`, `PUT /companies/{id}/assignments`, `POST /companies/{id}/contacts`, `PATCH/DELETE /contacts/{id}`, `POST /import` | administrateur |

Description OpenAPI : `api/back.openapi.yaml` (validée avec `openapi_spec_validator`). Le test de contrat `e2e/contract.py` (`npm run e2e:contract`, Python avec PyYAML, back démarré avec les données de démonstration) crée un jeu de données puis compare les réponses réelles aux schémas : champs inconnus, champs obligatoires absents, types, énumérations ; il vérifie aussi que les notes internes ne sortent pas. Il écrit des données de test : pas sur une base de production. Le comportement est vérifié par `server/test/back.test.ts`.

## Déploiement

Construction : `cd back && npm install && npm run build` (sortie `back/dist`), faite par le `Dockerfile`. Le back la sert sur `/admin/` ; `BACK_DIR` change le dossier. Les ressources sont référencées par des chemins relatifs : aucune configuration de sous-chemin n'est nécessaire.

Sécurité : en-têtes `Content-Security-Policy` (même origine, pas de script externe), `X-Frame-Options: DENY`, `nosniff`. Les jetons sont gardés dans `sessionStorage` (perdus à la fermeture de l'onglet).

## Vérifié / non vérifié

Vérifié : tests serveur (`back.test.ts` : droits, périmètres, comptes, CRM, import, reporting, préparation, planification reçue par la synchronisation) ; test de bout en bout dans un navigateur à 1360 × 900 (`e2e/back.cjs`) qui parcourt connexion, maquette CRM, import, comptes, préparation, planification, réception sur l'application mobile, reporting, export, droits du manager.
Non vérifié : grands volumes (les requêtes de reporting et de suggestions n'ont pas été mesurées au-delà de quelques lignes), navigateurs autres que Chromium, accessibilité au lecteur d'écran, impression, petits écrans (mise en page prévue mais non testée).
