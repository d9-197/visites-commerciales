# Spécification fonctionnelle — v0.1 (brouillon)

Les points marqués **[À VALIDER]** sont des hypothèses, pas des décisions.

## 1. Objectif

Permettre à un commercial terrain de préparer, réaliser et documenter ses visites
en un minimum de saisie, y compris sans réseau, et donner au back une base de
données exploitable (comptes rendus structurés, actions, prochaines étapes).

## 2. Utilisateurs et rôles [À VALIDER]

| Rôle | Droits |
|------|--------|
| Commercial | Ses clients, ses visites, ses actions |
| Manager | Lecture/commentaire sur les visites de son équipe, tableaux de bord |
| Admin | Utilisateurs, référentiels (types de visite, statuts, produits), paramétrage IA |

## 3. Périmètre fonctionnel

### MVP (v1)
1. **Authentification** : SSO/e-mail + déverrouillage biométrique de l'appli.
2. **Clients / contacts** : liste, recherche, fiche (société, contacts, adresse, historique des visites, actions ouvertes). Création rapide sur le terrain.
3. **Visites** : planifier, voir l'agenda du jour/semaine, démarrer, clôturer, annuler/reporter.
4. **Compte rendu** : champs structurés (objet, participants, résumé, besoins, objections, concurrents, décisions, prochaine étape, statut/température de l'opportunité) + notes libres + photos.
5. **Saisie vocale** : dictée dans n'importe quel champ ou dictée globale de la visite (voir §5).
6. **Assistance IA** : structuration et correction du compte rendu dicté (voir §6).
7. **Actions de suivi** : tâches avec échéance, liées à une visite/un client, rappels.
8. **Hors-ligne** : consultation et saisie sans réseau, synchronisation automatique ensuite (voir §7).
9. **Recherche** : clients, visites, actions.

### V2 (hors MVP)
Tournée optimisée et itinéraire, géolocalisation/check-in automatique, rappel de
visite à faire (clients non vus depuis N jours), objectifs et tableaux de bord
manager, opportunités/pipeline, documents partagés, intégration CRM/agenda, export PDF du CR.

## 4. Parcours principaux

**A. Avant la visite** : agenda → ouvrir la visite → fiche de préparation (dernier CR, actions ouvertes, contacts, points à aborder ; résumé IA optionnel).
**B. Pendant** : « Démarrer » → notes rapides (voix/texte/photo) horodatées.
**C. Après** : « Terminer » → dictée du compte rendu → l'IA propose une version structurée → le commercial relit, corrige, valide → actions créées → prochaine visite proposée.
**D. Hors réseau** : tout fonctionne localement ; indicateur d'état de synchro.

## 5. Saisie vocale

Contraintes : qualité en français, vocabulaire métier (noms de clients, produits), bruit (voiture, couloir).

| Option | Avantages | Limites |
|--------|-----------|---------|
| Dictée native OS | Gratuite, hors-ligne possible, simple | Qualité variable, jargon/noms propres mal reconnus, comportement différent iOS/Android |
| Transcription serveur (modèle ASR cloud ou auto-hébergé) | Meilleure qualité, vocabulaire personnalisable, même résultat partout | Réseau requis (ou file d'attente d'enregistrements), coût, données audio à protéger (RGPD) |

**Recommandation provisoire** : enregistrer l'audio localement, le transcrire côté serveur dès que le réseau le permet (c'est ce qui donne la meilleure qualité), avec dictée native en secours pour un texte immédiat. À confirmer par un test comparatif sur de vrais enregistrements terrain **[À VALIDER]**.

Règles : l'audio brut est conservé pour une durée configurable puis supprimé ; l'utilisateur peut toujours corriger le texte ; consentement et mention RGPD si des tiers sont enregistrés (il est préférable de ne dicter que des notes du commercial, pas d'enregistrer la conversation client).

## 6. Assistance IA

Fonctions, par ordre de valeur/risque :
1. **Nettoyage** : ponctuation, suppression des hésitations, correction des termes via un glossaire (clients, produits, acronymes).
2. **Structuration** : répartition du texte dicté dans les champs du compte rendu.
3. **Extraction** : actions, échéances relatives (« rappeler jeudi »), contacts mentionnés.
4. **Fiche de préparation** : synthèse de l'historique avant une visite.
5. **Questions de complétude** : « budget non mentionné, souhaitez-vous le préciser ? ».

Garde-fous :
- L'IA **propose**, le commercial **valide** ; rien n'est enregistré automatiquement dans les champs finaux.
- Afficher le texte original à côté de la version IA (diff) pour détecter les erreurs ; une IA peut inventer ou déformer un chiffre ou un nom.
- Pas d'ajout d'informations absentes de la dictée.
- Envoi à un service d'IA tiers = transfert de données clients : choix du fournisseur, contrat, hébergement UE à trancher **[À VALIDER]**.
- Journaliser texte brut / texte IA / texte final pour mesurer et améliorer la qualité.

## 7. Hors-ligne et synchronisation

- Base locale sur l'appareil ; file d'opérations en attente envoyée au back.
- Les données nécessaires hors-ligne : clients du commercial, visites des N prochains jours, historique récent.
- Conflits (même fiche modifiée sur deux appareils) : règle par défaut « dernière modification gagne » par champ, sauf pour les notes (conservées en entier avec une alerte). **[À VALIDER]**
- La transcription et l'IA nécessitent le réseau : les enregistrements restent en file jusqu'à reconnexion.

## 8. Modèle de données (esquisse)

- **Utilisateur** (id, nom, rôle, équipe)
- **Société** (id, nom, adresse, secteur, propriétaire commercial)
- **Contact** (id, société, nom, fonction, tél., e-mail)
- **Visite** (id, société, contacts[], commercial, date/heure prévue, début/fin réels, type, statut, lieu)
- **CompteRendu** (id, visite, champs structurés, texte brut dicté, texte IA, version finale, statut de validation)
- **Note** (id, visite, type voix/texte/photo, contenu, horodatage)
- **Action** (id, visite, société, responsable, échéance, statut)
- **Enregistrement** (id, visite, fichier, durée, statut de transcription, date de purge)
- **Glossaire** (terme, variantes, catégorie)

## 9. Architecture envisagée [À VALIDER]

- **Client** : un seul code pour iOS/Android/tablette (React Native ou Flutter) plutôt qu'une PWA : accès micro, stockage local et biométrie sont plus fiables en natif, en particulier sur iOS.
- **Back** : API REST, base PostgreSQL, stockage objet pour l'audio/photos, file de traitement pour transcription et IA.
- **Sécurité** : chiffrement local, authentification par jetons, effacement à distance, journal d'audit.

## 10. Exigences non fonctionnelles

- Démarrage de la saisie d'une visite en ≤ 3 appuis.
- Utilisable d'une main, gros éléments tactiles, mode sombre, lisible en plein soleil.
- Tablette : affichage en deux colonnes (liste + détail).
- Langues : français ; internationalisation prévue dès le départ **[À VALIDER]**.
- RGPD : base légale, durée de conservation, droit d'accès/suppression, registre des sous-traitants (transcription, IA).

## 11. Questions ouvertes

1. Nombre d'utilisateurs, présence de managers ?
2. CRM existant à synchroniser, ou le back est la source de vérité ?
3. Français uniquement ?
4. Données sensibles ? Contraintes d'hébergement (UE, interne) ?
5. Appareils : parc imposé (iOS, Android, les deux) ? Gestion via MDM ?
6. Budget et fournisseur pour transcription et IA ?
