# Premier prototype : état et limites

Branche `ccr-bf3049f2-b95bh3`. Objectif : éprouver la synchro hors-ligne, les droits et l'API CRM, et avoir une application mobile minimale qui s'appuie sur le même moteur.

## 1. Contenu

| Dossier | Rôle |
|---------|------|
| `server/` | Back en TypeScript (Express, PostgreSQL) : API mobile, API CRM, administration minimale, import CRM |
| `packages/sync-core/` | Cœur de synchro partagé : types, règles, moteur hors-ligne, client HTTP, stockage mémoire et SQLite |
| `mobile/` | Application Expo (React Native) minimale |
| `db/schema.sql` | Schéma de données |
| `api/` | Contrat OpenAPI |

## 2. Résultats vérifiés

**85 tests automatisés passent** (`npm test`), sur un vrai PostgreSQL 16 : un serveur HTTP réel, des clients HTTP réels, une base neuve par fichier de test.

| Scénario (`PHASE0_PLAN_COMPLET.md` §5) | Résultat |
|---|---|
| 1. Deux appareils, même champ : champs différents appliqués, même champ court : le serveur l'emporte | Passe |
| 2. Même texte long modifié des deux côtés : deux versions conservées | Passe |
| 3. Opération envoyée deux fois : aucun doublon | Passe |
| 4. Affectation retirée, mode de visibilité changé, supérieur changé : retraits d'accès reçus par l'appareil | Passe |
| 5. Manager et directeur voient exactement ce que la règle prévoit (modes 1 et 2) | Passe |
| 6. La note privée n'apparaît que chez son auteur, jamais dans l'API CRM | Passe |
| 7. Reprise après coupure au milieu d'un lot | Passe |
| 8. 200 utilisateurs en même temps, chacun ne voit que ses données | Passe (environ 4 s sur cette machine ; mesure indicative) |
| 9. Transaction validée en retard : relue grâce au recouvrement du curseur | Passe. Un contrôle négatif montre que **sans recouvrement la ligne est bien perdue** : le risque est réel et la parade fonctionne dans ce cas |

Autres vérifications : connexion, verrouillage après 5 échecs, version minimale (426), rotation du jeton de renouvellement et révocation en cas de réutilisation, déconnexion ; refus de modification d'un collègue ; validation du compte rendu ; actions (terminer, annuler, suppression refusée) ; API CRM (clé, deux clés valides, clé révoquée, comptes rendus validés seulement, suppressions visibles, lecture par curseur et pagination) ; import CRM (création, retrait d'affectation, client absent marqué inactif) ; moteur côté appareil (file d'opérations, fusion des modifications, coupure réseau, refus, conflit, retrait d'accès) **avec les deux stockages** (mémoire et SQLite).

L'application mobile : le code passe le contrôle de types, et le paquet JavaScript se génère pour Android et pour iOS avec Metro (570 modules).

## 3. Ce qui n'est pas vérifié

- **L'application n'a jamais tourné** sur un téléphone, un émulateur ou une tablette. Rien n'est vérifié sur l'interface, le trousseau (`expo-secure-store`), la connexion réelle au serveur, ni le comportement en arrière-plan.
- **Le stockage SQLite** est testé avec `node:sqlite`, pas avec `expo-sqlite` : les requêtes sont les mêmes, mais le pilote natif n'est pas exercé.
- **Les 4 tests de faisabilité mobile** du premier jalon (`PHASE0_PLAN.md` §4) restent à faire : audio en arrière-plan, reprise après appel, base chiffrée, notifications locales. Le choix de React Native n'est donc **toujours pas confirmé**.
- Charge : le test de 200 utilisateurs est un test de bon fonctionnement sur de petits volumes, pas un test de performance.
- Aucun test sur un jeu de données volumineux, ni sur plusieurs instances du back.

## 4. Écarts avec le contrat (`api/`, `docs/API.md`)

Non implémentés :
- double authentification ;
- dictée hors-ligne et transcription asynchrone (la dictée en ligne et la synthèse par IA existent : `IA_MISTRAL.md`) ;
- enregistrements audio, pièces jointes, glossaire, propositions de l'IA, `/usage`, `/reports/{id}/quality`, `/error-reports` (réponse `not_implemented` pour les entités) ;
- fenêtre hors-ligne (la synchro initiale envoie tout ce qui est visible) ;
- limitation de débit ;
- console d'administration : seulement création d'utilisateur (mot de passe fixé directement, sans lien d'activation), changement de supérieur, affectations d'un client, réglage du mode de visibilité ;
- import CRM : fonction appelable, pas de planification ni de client HTTP vers le CRM.

Ajouts ou différences :
- codes `already_exists` et `not_implemented` pour une opération refusée ;
- la réutilisation d'un jeton de renouvellement renvoie `invalid_credentials` ;
- les notes de visite n'ont pas de version : dernière écriture gagnante ;
- le conflit n'est détecté que sur les modifications passées par l'API mobile (journal des opérations) : un changement fait par le CRM ou par l'administration n'est pas pris en compte ;
- le calcul des retraits d'accès compare la visibilité de tous les utilisateurs avant et après, en ligne : correct mais lent à grande échelle, à confier à une tâche en arrière-plan.

## 5. Hypothèses prises par défaut (à confirmer)

- Un compte rendu validé reste modifiable par son auteur, sans revenir en brouillon.
- Valider un compte rendu exige un résumé non vide.
- Seuils : 5 échecs de connexion, verrouillage de 15 minutes, jeton d'accès de 15 minutes, jeton de renouvellement de 30 jours, recouvrement de 50 numéros de changement.

## 6. Lancer

```bash
npm install                      # à la racine
npm run pg:start                 # PostgreSQL local jetable (sans Docker) ; ou : docker compose up -d db
npm test                         # tests du back et du moteur
npm run typecheck
# démonstration
DATABASE_URL=postgres://postgres@127.0.0.1:54329/visites npm -w server run seed
DATABASE_URL=... JWT_SECRET=... npm -w server start
cd mobile && npm install && npx expo start
```

`docker-compose.yml` n'a pas pu être testé ici (pas de démon Docker). Le secret JWT par défaut du code est un secret de développement : à remplacer.

## 7. Suite proposée

1. Faire tourner l'application sur un téléphone Android et un iPhone, et exécuter les tests de faisabilité (audio en arrière-plan en premier).
2. Mettre en œuvre le pipeline voix et IA derrière des adaptateurs interchangeables, avec la mesure de qualité intégrée.
3. Compléter l'administration et planifier l'import CRM.
4. Valider les hypothèses du §5 et le format de l'API CRM avec l'équipe concernée.
