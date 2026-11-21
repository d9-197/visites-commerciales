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
3. Dans la visite : le cartouche du haut montre le statut (en couleur), les dates et **l'adresse de la visite**. Toucher l'adresse (soulignée) ouvre le choix de l'application d'itinéraire. Le **crayon** à côté de « Prévue » modifie la date et l'heure ; le crayon à côté de « Adresse de la visite » modifie l'adresse ; « Historique des modifications » liste les changements. Boutons de statut : **Visite organisée avec le client**, **Démarrer la visite**, **Terminer la visite**. Une fois la visite démarrée, plus de crayons (ni adresse ni date).
   Testez aussi le **bouton retour du téléphone** : il doit remonter l'application (fermer une fenêtre, revenir à l'écran précédent) sans la quitter.
   Les heures se règlent par pas de 15 minutes. Quand le compte rendu est validé et la visite terminée, elle devient **Validée** et disparaît de la liste : l'interrupteur « Afficher les visites validées » la montre. Même principe pour les actions terminées (interrupteur sur l'écran Actions).
   Dans **Visites**, essayer « Par client » et « Par date » ; mettre une date prévue dans le passé pour voir « En retard » (rouge). Dans **Réglages**, essayer le mode sombre.
4. **Actions** → « + Nouvelle » : créer « Envoyer le devis » avec une échéance choisie dans le sélecteur de date.
5. **Hors-ligne** : activer le mode avion, créer une autre action. La barre du haut doit passer à « Hors-ligne · 1 en attente ». Réactiver le réseau, toucher **Synchroniser** : « Synchronisé ».
6. Vérifier côté serveur (ou avec un second téléphone/compte) que les données sont arrivées. Avec `manager@exemple.invalid`, les visites de `commercial1` apparaissent aussi (règle de hiérarchie).
7. **Réglages** → **Se déconnecter** : les données locales sont effacées.

Chaque appareil/navigateur garde ses données dans le stockage du site : vider les données du site efface aussi la file d'attente non synchronisée.

**Droits à tester** : avec `manager@exemple.invalid`, ouvrir une visite « À organiser » de commercial1 : seul le crayon de l'adresse est proposé (pas celui de la date) ; une fois la visite « Organisée », le manager n'a plus de crayon, mais commercial1 ou commercial2 (client partagé, visibilité en mode 1) en garde un.

**Adresses de démonstration** : Dupont SA et Atelier Roux ont une adresse ; Groupe Bernard n'en a pas (cas « aucune adresse », à saisir à la main).

**Synthèse par IA (facultatif)** : si `MISTRAL_API_KEY` est renseignée dans `.env`, le bouton « Synthétiser les notes avec l'IA » de la visite envoie les notes à Mistral et affiche une proposition à relire. Sans clé, le bouton affiche « La synthèse par IA n'est pas activée sur ce serveur ». **Ne mettez pas de vraies notes de clients tant que le contrat de sous-traitance et le traitement dans l'UE ne sont pas confirmés** (voir `docs/IA_MISTRAL.md`).

**Dictée vocale (facultatif, même clé Mistral)** : « Dicter une note » enregistre la voix, la transcrit avec Voxtral et affiche le texte à relire avant d'ajouter la note. **Important pour votre essai sur le réseau local** : le micro du navigateur exige **HTTPS** ; sur une page en HTTP simple, le bouton est remplacé par « Choisir un enregistrement audio » (enregistreur du téléphone sur Android, sinon fichier). Pour tester le micro direct, servez l'application en HTTPS (hors périmètre ici). Cela demande le réseau : pas de dictée hors-ligne pour l'instant.

## 3. Limites propres à la version web sur HTTP

- Page servie en **HTTP simple** : pas d'installation sur l'écran d'accueil ni de fonctionnement après rechargement hors-ligne (cela exige HTTPS et un service worker, non faits). Le mode hors-ligne se teste **sans recharger la page** (mode avion après ouverture).
- Données locales dans `localStorage` (non chiffrées, environ 5 Mo). C'est une version d'essai.
- Les jetons de connexion sont aussi dans `localStorage`, moins protégés que le trousseau d'un téléphone.

## 4. Ce qui a été vérifié, et ce qui ne l'a pas été

Vérifié dans l'environnement de développement : l'application web se compile ; un test automatique pilote un vrai navigateur au format téléphone (390 × 800) contre le vrai back et une vraie base (`e2e/web.cjs`) : connexion, visibilité des clients selon l'utilisateur, visite, note, compte rendu, action, saisie hors-ligne puis resynchronisation, vérification côté base, persistance après rechargement, déconnexion qui efface tout ; aucune erreur JavaScript. Les étapes de l'image Docker ont été rejouées à la main sur une copie (installation de production, démarrage avec les variables obligatoires, refus de démarrer sans `JWT_SECRET` ou sans `SEED_PASSWORD`), puis le même test a passé.

**Non vérifié** : les sélecteurs de date et d'heure **natifs** de l'application Expo (iOS et Android) et l'ouverture réelle des applications Plans, Google Maps et Waze, qui n'ont jamais tourné sur un appareil. Sur la version web, la liste d'applications proposée et les liens générés sont testés, mais pas leur ouverture dans les applications. Aussi : la construction de l'image Docker elle-même et `docker compose` (pas de démon Docker ici) ; le rendu sur un vrai téléphone (autre moteur de navigateur que celui du test, clavier virtuel, barre d'adresse) ; Safari sur iPhone.

## 5. Application native (Expo)

`cd mobile && npm install && npx expo start` lance l'application native. La version d'Expo utilisée (SDK 52) n'est peut-être pas prise en charge par l'application Expo Go actuelle des magasins : à vérifier avant de s'y fier. Pour un essai fiable sur appareil, prévoir une application de développement compilée.
