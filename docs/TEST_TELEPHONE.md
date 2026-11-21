# Tester la première version sur un téléphone

Version minimaliste : une **application web** (la même interface que l'application mobile, compilée pour le navigateur) servie par le back. Elle s'ouvre dans le navigateur du téléphone, sans installation ni Expo. Elle exerce la vraie synchro avec le vrai back et la vraie base.

## Ce qu'elle permet

Connexion · visites regroupées par client (ou à plat par date) avec date prévue, commencée et réalisée, date prévue modifiable avec le sélecteur de date et d'heure du téléphone · adresse de la visite (celle du client par défaut, modifiable) et ouverture de l'application d'itinéraire de votre choix · mode clair, sombre ou réglage du système (Réglages › Affichage) · liste des clients reçus du « CRM » (données de démonstration) · création d'une visite depuis un client · démarrer/terminer · notes · compte rendu saisi à la main et validé · actions (créer, modifier, terminer, annuler) · état « synchronisé / hors-ligne, n en attente » · déconnexion qui efface les données de l'appareil.

## Ce qu'elle ne fait pas

Dictée vocale, IA, photos, double authentification, chiffrement des données locales, notifications. Ce n'est **pas** l'application native : les tests de faisabilité (audio en arrière-plan, base chiffrée, notifications) restent à faire avec l'application Expo sur appareil.

## 1. Démarrer le back (sur votre serveur Docker)

```bash
cp .env.example .env
# renseigner DB_PASSWORD, JWT_SECRET (openssl rand -base64 48), et pour un essai :
#   SEED_DEMO=1  et  SEED_PASSWORD=<un mot de passe de test>
docker compose up --build
```

L'application est alors à `http://<adresse du serveur>:3000` (ou le port `APP_PORT`). Le téléphone doit pouvoir joindre le serveur (même réseau, ou VPN).

Comptes de démonstration (mot de passe = `SEED_PASSWORD`) : `commercial1@exemple.invalid` (voit Dupont SA et Atelier Roux), `commercial2@exemple.invalid` (voit Atelier Roux et Groupe Bernard), `manager@exemple.invalid`, `directeur@exemple.invalid`, `admin@exemple.invalid`.

**Attention** : les données de démonstration et ces comptes ne sont destinés qu'à un essai sur un réseau maîtrisé. Ne mettez pas de vraies données, et n'exposez pas ce serveur sur Internet tel quel.

Sans Docker : `npm install && npm run pg:start`, puis `npm -w server run seed` et `npm -w server start` (voir `docs/PROTOTYPE.md` §6), après `cd mobile && npm install && npm run build:web`.

## 2. Parcours de test conseillé (5 minutes)

1. Ouvrir l'adresse dans le navigateur du téléphone, se connecter avec `commercial1@exemple.invalid`.
2. **Clients** → toucher « Dupont SA » : une visite est créée. **Démarrer**, ajouter une note, écrire un compte rendu, **Valider**.
3. Dans la visite : **toucher l'adresse** (soulignée) et choisir l'application d'itinéraire ; modifier l'adresse puis **Enregistrer l'adresse**, ou **Adresse du client** pour revenir à celle du CRM ; changer **Date et heure prévues** avec le sélecteur, **Enregistrer la date**, puis **Terminer** : la date réalisée apparaît. Dans **Visites**, essayer « Par client » et « Par date ». Dans **Réglages**, essayer le mode sombre.
4. **Actions** → « + Nouvelle » : créer « Envoyer le devis » avec une échéance choisie dans le sélecteur de date.
5. **Hors-ligne** : activer le mode avion, créer une autre action. La barre du haut doit passer à « Hors-ligne · 1 en attente ». Réactiver le réseau, toucher **Synchroniser** : « Synchronisé ».
6. Vérifier côté serveur (ou avec un second téléphone/compte) que les données sont arrivées. Avec `manager@exemple.invalid`, les visites de `commercial1` apparaissent aussi (règle de hiérarchie).
7. **Réglages** → **Se déconnecter** : les données locales sont effacées.

Chaque appareil/navigateur garde ses données dans le stockage du site : vider les données du site efface aussi la file d'attente non synchronisée.

**Adresses de démonstration** : Dupont SA et Atelier Roux ont une adresse ; Groupe Bernard n'en a pas (cas « aucune adresse », à saisir à la main).

## 3. Limites propres à la version web sur HTTP

- Page servie en **HTTP simple** : pas d'installation sur l'écran d'accueil ni de fonctionnement après rechargement hors-ligne (cela exige HTTPS et un service worker, non faits). Le mode hors-ligne se teste **sans recharger la page** (mode avion après ouverture).
- Données locales dans `localStorage` (non chiffrées, environ 5 Mo). C'est une version d'essai.
- Les jetons de connexion sont aussi dans `localStorage`, moins protégés que le trousseau d'un téléphone.

## 4. Ce qui a été vérifié, et ce qui ne l'a pas été

Vérifié dans l'environnement de développement : l'application web se compile ; un test automatique pilote un vrai navigateur au format téléphone (390 × 800) contre le vrai back et une vraie base (`e2e/web.cjs`) : connexion, visibilité des clients selon l'utilisateur, visite, note, compte rendu, action, saisie hors-ligne puis resynchronisation, vérification côté base, persistance après rechargement, déconnexion qui efface tout ; aucune erreur JavaScript. Les étapes de l'image Docker ont été rejouées à la main sur une copie (installation de production, démarrage avec les variables obligatoires, refus de démarrer sans `JWT_SECRET` ou sans `SEED_PASSWORD`), puis le même test a passé.

**Non vérifié** : les sélecteurs de date et d'heure **natifs** de l'application Expo (iOS et Android) et l'ouverture réelle des applications Plans, Google Maps et Waze, qui n'ont jamais tourné sur un appareil. Sur la version web, la liste d'applications proposée et les liens générés sont testés, mais pas leur ouverture dans les applications. Aussi : la construction de l'image Docker elle-même et `docker compose` (pas de démon Docker ici) ; le rendu sur un vrai téléphone (autre moteur de navigateur que celui du test, clavier virtuel, barre d'adresse) ; Safari sur iPhone.

## 5. Application native (Expo)

`cd mobile && npm install && npx expo start` lance l'application native. La version d'Expo utilisée (SDK 52) n'est peut-être pas prise en charge par l'application Expo Go actuelle des magasins : à vérifier avant de s'y fier. Pour un essai fiable sur appareil, prévoir une application de développement compilée.
