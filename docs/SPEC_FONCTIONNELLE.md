# Spécification fonctionnelle — v0.1 (brouillon)

Les points marqués **[À VALIDER]** sont des hypothèses, pas des décisions.

## 1. Objectif

Permettre à un commercial terrain de préparer, réaliser et documenter ses visites
en un minimum de saisie, y compris sans réseau, et donner au back une base de
données exploitable (comptes rendus structurés, actions, prochaines étapes).

## 1 bis. Décisions validées (20/11/2026)

| Sujet | Décision | Conséquence |
|-------|----------|-------------|
| Volume | Grande structure, > 50 utilisateurs | Hiérarchie multi-équipes, droits fins, SSO d'entreprise, administration, montée en charge du back |
| CRM | **Modifié le 20/11** : le back est synchronisé avec le CRM par API REST (côté back). Le CRM envoie les infos clients ; les plannings de visite et les CR vivent dans l'application (le back). Remplace la décision « aucun CRM ». CRM non nommé, documentation d'API à fournir | Clients et contacts = lecture seule venant du CRM (source de vérité CRM) ; visites, CR, actions = source de vérité back ; synchro périodique (5-15 min) via un module d'intégration dans le back ; table de correspondance des identifiants ; reprise sur erreur, journal de synchro, respect des quotas de l'API |
| Langues | Multilingue | Interface i18n dès le départ ; reconnaissance vocale et IA dans chaque langue ; liste des langues à fixer |
| Langues précises | Français, anglais, espagnol, italien, allemand, néerlandais | 6 langues à tester en transcription et IA ; glossaire par langue ; langue du CR distincte de la langue de l'interface |
| Appareils | Parc imposé géré par MDM | Modèle exact (iOS/Android, versions) à communiquer ; distribution et politiques via le MDM ; pas de store public nécessaire |
| Hiérarchie | 3 niveaux : commercial, manager, directeur | Chaque niveau voit ce qui est en dessous ; un manager a une équipe, un directeur plusieurs équipes |
| Client supprimé ou fusionné dans le CRM | Visites conservées, client marqué inactif | La synchro marque le client inactif au lieu de le supprimer ; en cas de fusion, rattachement des visites au client absorbant à définir (reprise des identifiants) ; plus de nouvelle visite sur un client inactif |
| Clients | Partagés entre plusieurs commerciaux | Table d'affectation client-commerciaux ; historique visible par tous les intervenants ; droits par client ; gestion des modifications concurrentes |
| Langue de dictée | Une langue par commercial, fixée dans le profil | Pas de détection automatique en v1 ; une langue de dictée passée au moteur ; la langue du CR peut différer de celle de l'interface |
| Visibilité des CR | **Paramétrable** (décision du 21/11) entre deux modes : (1) CR visible par tous les commerciaux rattachés au client, plus leur hiérarchie ; (2) CR visible par son auteur et sa hiérarchie seulement. La note privée reste réservée à l'auteur dans les deux modes et n'est pas exposée à l'API du CRM | Réglage dans la console d'administration ; portée du réglage : **globale** pour l'instant, affinage (équipe, client) prévu plus tard, donc ne pas figer le modèle de données sur un réglage unique ; le changement de mode s'applique à l'historique existant, ce qui doit être explicite pour l'administrateur |
| Fournisseur transcription/IA | Non choisi, à comparer | Comparatif à produire (traitement UE, langues, coût, DPA) à partir de sources vérifiées |
| MDM | NinjaOne (**hors périmètre de ce projet depuis le 21/11**) | Distribution et politiques de l'appli via NinjaOne ; à vérifier : plateformes mobiles gérées (iOS/Android), mode de déploiement d'une appli privée, configuration à distance (AppConfig), effacement à distance |
| CRM (précisions du 20/11) | CRM interne, non nommé ; clients en lecture seule dans l'appli (pas de création) ; le CRM vient **récupérer** visites et CR par API | Le back expose une API REST dédiée au CRM (authentification par clé/jeton de service, pagination, filtre « modifié depuis », identifiants stables, suppression logique) ; le back lit les clients du CRM de son côté ; pas d'écriture dans le CRM |
| API pour le CRM : périmètre | « Tout récupérer potentiellement », actions comprises | L'API couvre toutes les entités : visites, comptes rendus, notes, actions, contacts liés, participants, rattachements, avec statut et historique de modification, y compris annulations et suppressions logiques. Exclus de l'API (décision du 21/11) : notes privées et audio brut |
| Administration des comptes | L'IT, via une console d'administration | Console web (création, réinitialisation, désactivation, rôles, rattachement hiérarchique, affectation client-commerciaux) ; pas d'inscription libre-service |
| Échanges avec le CRM | Authentification par clé d'API ou jeton fixe dans les deux sens. Le CRM envoie : société, adresse, secteur, contacts (nom, fonction, téléphone, e-mail), commercial(s) responsable(s) | Clés à renouveler régulièrement et à stocker hors du dépôt ; les commerciaux responsables du CRM alimentent l'affectation client-commerciaux (donc la visibilité) ; pas de statut ni d'opportunités en v1 |
| Volume de dictée | ~10 h d'audio par commercial et par mois | Base de calcul du budget : 10 h/mois/utilisateur, à comparer au plafond de 30 € |
| Parc | Mixte iOS + Android, géré par NinjaOne | Appli multiplateforme, tests sur les deux systèmes ; dictée native différente selon l'OS |
| Authentification | Pas de SSO, comptes propres | Gestion des comptes dans le back : mots de passe (hachage), réinitialisation, authentification à deux facteurs, verrouillage, désactivation à distance ; à prévoir dans le périmètre et le budget |
| Budget IA | 30 € maximum par mois et par utilisateur (transcription + IA) | Contrainte de coût à vérifier sur chaque fournisseur : volume mensuel d'audio estimé par commercial à définir, plafond/quotas par utilisateur à prévoir dans le back |
| Données | Hébergement UE obligatoire | Fournisseurs transcription/IA limités à ceux qui traitent dans l'UE (ou auto-hébergement UE) ; contrat de sous-traitance (DPA) ; pas de transfert hors UE |

### 1 ter. Visites : statuts, adresse, historique, retards (décisions du 21/11)

- **Statuts** : à organiser → **organisée avec le client** → en cours → terminée → **validée** ; annulée possible avant la fin. Une visite devient **validée** automatiquement quand son compte rendu est validé, ce qui n'est possible qu'**une fois la visite terminée**. Les visites validées sont **masquées par défaut** dans la liste (interrupteur pour les afficher), de même que les actions terminées ou annulées.
- **Heures de visite** : réglées par pas de **15 minutes**. Chaque statut a une couleur ; le libellé reste affiché (la couleur n'est jamais seule).
- **Adresse de la visite** : celle du client à la création, puis propre à la visite (elle ne suit pas le client). Modifiable par **toute personne qui voit la visite** tant qu'elle est « à organiser » ; par **un commercial seulement** une fois « organisée » ; **plus modifiable** dès que la visite est commencée. Modification par une icône (crayon), pas par un champ dans la vue. À étudier plus tard : aide à la saisie (dictée).
- **Date prévue** : modifiable par l'auteur de la visite par une icône (crayon) dans le cartouche, tant que la visite n'est pas commencée. **L'historique des modifications** (date prévue et adresse : qui, quand, ancienne et nouvelle valeur) est consultable.
- **Retards** (hypothèse à confirmer) : visite à organiser ou organisée dont l'heure prévue est dépassée de plus d'une heure ; action à faire dont l'échéance est passée. Signalées en rouge (liseré, pastille « En retard »).
- **Notes durant visite** : prises pendant la visite ; elles servent à rédiger le compte rendu et alimentent la génération par IA. L'auteur peut les **modifier** et les **supprimer** (suppression avec confirmation).
- **Notes internes** (décision du 21/11) : informations importantes pour les commerciaux, **partagées avec la hiérarchie** de leur auteur (manager, directeur : lecture seule), quel que soit le mode de visibilité des comptes rendus. Elles **n'apparaissent pas dans le compte rendu** (susceptible d'être envoyé au client) et ne sont envoyées **ni à l'IA ni au CRM**. Écrites par les commerciaux qui voient la visite ; modifiables et supprimables (avec confirmation) par leur auteur. La « note privée » du schéma (auteur seul, une par visite) n'est plus utilisée par l'application : à retirer ou à fusionner avec cette notion.
- **Écran du compte rendu** (distinct de l'écran de visite) : l'écran de visite sert à **capter** (statut, notes, notes internes, dictée) ; l'écran du compte rendu sert à **rédiger** : génération par IA à partir des notes durant visite, correction et complément à la main ou à la voix (micro sur chaque champ), validation. La génération est possible **visite en cours, ou terminée tant que le compte rendu n'est pas validé** ; pas avant le début de la visite (pas de notes), pas après la validation.
- **Saisie** : l'ajout d'une note manuelle se fait par un bouton (fenêtre dédiée) pour alléger l'écran ; la **dictée** (icône micro) est possible pour une note et **directement dans chaque champ du compte rendu** (le texte est ajouté à la fin du champ).
- **Règles du compte rendu et des actions** (décisions du 21/11, soir) :
  1. Le compte rendu **ne se valide qu'une fois la visite terminée**.
  2. Un compte rendu **validé n'est plus modifiable** ; on peut seulement le **remettre en brouillon**, avec confirmation. La visite repasse alors à « terminée » ; les actions déjà créées sont conservées ; à la nouvelle validation, seules les nouvelles actions prévues sont créées.
  3. Sur une visite **terminée** (ou validée, ou annulée), les **notes durant visite** ne se modifient plus (ajout, modification, suppression). Les notes internes restent possibles.
  4. Les **actions ne sont créées qu'à la validation du compte rendu** : jusque-là, ce sont des « **actions prévues** » dans le brouillon (proposées par l'IA ou ajoutées à la main), que le serveur transforme en actions à la validation. Après la validation, on ajoute une action directement depuis la visite.
  5. Une action naît **toujours d'une visite** : plus de création depuis la vue Actions. La visite affiche le **compteur** « n à faire · m terminées » et ouvre la liste filtrée ; depuis une action, on **ouvre la visite**.
  6. Une **visite validée ne disparaît pas de la liste tant qu'il lui reste des actions à faire** (elle n'est masquée qu'une fois toutes les actions terminées ou annulées).
- **Étapes d'une visite** (décision du 21/11) : « Effectuée » (ancien « Terminée » : le commercial a quitté le client ; bouton « Fin du rendez-vous »), « CR validé » (compte rendu validé, actions encore à faire), puis « **Terminée** » quand tout est fait : compte rendu validé **et** plus aucune action à faire. « Terminée » est déduite (pas un statut stocké) ; les visites terminées sont masquées par défaut (interrupteur « Afficher les visites terminées »).
- **Règles complémentaires** (adoptées le 21/11) : (1) compte rendu non validé depuis plus de 2 jours après la fin du rendez-vous : pastille et bandeau rouges « CR à valider » (visible de la hiérarchie, qui voit les visites) ; (2) « Aucune action à prévoir » à cocher pour valider un compte rendu sans action ; (3) annulation refusée tant que des actions sont à faire (cas aujourd'hui inatteignable par l'interface, gardé côté serveur) ; (4) échéance d'action antérieure à la visite refusée (tolérance d'un jour) ; (5) validation, remise en brouillon et suppression inscrites dans l'historique de la visite ; (6) remise en brouillon interdite une fois le compte rendu transmis au client (colonne prête, **aucune fonction de transmission n'existe encore**) ; (7) fin de rendez-vous sans aucune note : confirmation ; (8) notes internes : ajout possible après validation, modification et suppression figées ; (9) pour les managers et directeurs, onglet Actions : « Équipe » = actions à faire et en retard par commercial.
- **Envoi par e-mail d'une visite** (décision du 21/11) : bouton « Envoyer par e-mail » sur la visite. Envoi **par le back (SMTP)**, en ligne seulement. **Destinataires : l'utilisateur et sa hiérarchie** (supérieurs), **jamais le client** ni un collègue. Contenu au choix : compte rendu **validé** seulement, actions (hors annulées), notes durant visite ; message libre facultatif (dictable). **Les notes internes et privées ne sont jamais envoyées.** Réponse à l'expéditeur par « répondre ». Chaque envoi est journalisé (qui, à qui, quelles parties, résultat ; pas le contenu), 20 envois par heure et par utilisateur. Hors périmètre : envoi au client (contacts du CRM, saisie libre), pièces jointes PDF, et donc `sent_to_client_at` n'est jamais renseigné par cette fonction.
- **Dictée partout** (décision du 21/11) : tous les champs de saisie de texte liés à une visite proposent le micro (texte ajouté à la fin du champ, à relire) : champs du compte rendu, notes durant visite et internes (ajout et modification), intitulé d'une action (ajout et modification), adresse de la visite, propositions de l'IA. Exclus : connexion (adresse du serveur, e-mail, mot de passe) ; la fiche client est en lecture seule (CRM). La dictée passe par une visite (quota et traçabilité) ; hors-ligne elle n'est pas disponible.
- **Fiche client** (décision du 21/11) : toucher un client dans l'onglet Clients n'enregistre plus rien. La fiche donne les informations du client (CRM, lecture seule), les visites précédentes avec un extrait de leur compte rendu (validé ou brouillon), les actions associées au client et un bouton explicite « + Planifier une visite ».
- **Suppression d'une visite** : statut « **Supprimée** » (`deleted`), définitif, avec confirmation. Autorisée au **commercial auteur** de la visite et au **directeur** (qui la voit) ; refusée au manager et aux autres commerciaux. **Refusée tant qu'il reste des actions à faire** sur la visite. La visite est conservée et synchronisée, **masquée par défaut** (interrupteur « Afficher les visites supprimées » sur la liste des visites et sur la fiche client) ; elle n'est plus modifiable (ni notes, ni compte rendu, ni actions, ni dates). Interprétations à confirmer : pas de restauration ; une visite validée peut être supprimée ; la suppression n'est pas inscrite dans l'historique des dates/adresses.
- **Bouton retour du téléphone** : remonte l'application comme le bouton « Retour » ; il ne quitte l'application qu'à l'écran d'accueil.
- Interprétation à confirmer : « commerciaux » = utilisateurs de rôle commercial (pas manager ni directeur), qui voient la visite.

## 2. Utilisateurs et rôles [À VALIDER]

| Rôle | Droits |
|------|--------|
| Commercial | Ses clients, ses visites, ses actions |
| Manager | Lecture/commentaire sur les visites de son équipe (hiérarchie multi-niveaux), tableaux de bord |
| Admin | Utilisateurs, référentiels (types de visite, statuts, produits), paramétrage IA |

## 3. Périmètre fonctionnel

### MVP (v1)
1. **Authentification** : comptes propres (e-mail + mot de passe, double authentification) + déverrouillage biométrique de l'appli.
2. **Clients / contacts** : liste, recherche, fiche (société, contacts, adresse, historique des visites, actions ouvertes). Alimentés par le CRM (lecture seule dans l'appli). Pas de création de client dans l'application (décision du 20/11).
3. **Visites** : planifier, voir l'agenda du jour/semaine, démarrer, clôturer, annuler/reporter.
   Chaque visite a une **adresse** : celle du client (CRM) par défaut, modifiable ; en touchant l'adresse, l'utilisateur choisit l'application d'itinéraire à ouvrir. Dates et heures prévues saisies avec le sélecteur natif du système.
4. **Compte rendu** : champs structurés (objet, participants, résumé, besoins, objections, concurrents, décisions, prochaine étape, statut/température de l'opportunité) + notes libres + photos.
5. **Saisie vocale** : dictée dans n'importe quel champ ou dictée globale de la visite (voir §5).
6. **Assistance IA** : structuration et correction du compte rendu dicté (voir §6).
7. **Actions de suivi** : voir §3 bis.
8. **Hors-ligne** : consultation et saisie sans réseau, synchronisation automatique ensuite (voir §7).
9. **Recherche** : clients, visites, actions.

### 3 bis. Actions de suivi

**Définition** : tâche avec intitulé, client, échéance facultative, rappel facultatif, statut (à faire, terminée, annulée), responsable, visite d'origine facultative.

**Création**
- Depuis le compte rendu : l'IA propose des actions (intitulé + échéance déduite de la dictée). Le commercial coche, corrige l'intitulé et la date, ajoute ou ignore des lignes. **Rien n'est créé avant la validation du compte rendu.**
- Manuellement : « + Nouvelle » dans la liste des actions, « + Action » dans la fiche client.
- À la voix : l'intitulé peut être dicté ; le résultat est signalé « dicté, à vérifier » et reste modifiable.

**Modification** : intitulé, client, échéance, rappel (aucun, jour même 9 h, veille 17 h), statut. Report de 7 jours en un appui. Cocher la case dans la liste suffit pour terminer ou rouvrir.

**Suppression** : pas de suppression ; une action est « annulée » pour garder l'historique (et la rendre récupérable par l'API).

**Responsable** : l'auteur, non modifiable dans le MVP. L'assignation à un collègue est prévue après le MVP (décision du 21/11).

**Droits** : le responsable modifie ses actions ; un manager voit celles de son équipe (lecture).

**Hors-ligne** : création et modification possibles ; envoi à la reconnexion ; conflits : règle du §7.

**Rappels** : notification locale sur l'appareil à l'heure choisie (fonctionne hors-ligne).

### V2 (hors MVP)
Assignation d'une action à un collègue (le modèle de données conserve dès le MVP un responsable distinct de l'auteur), tournée optimisée et itinéraire, géolocalisation/check-in automatique, rappel de
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
- **Action** (id, société, visite d'origine facultative, responsable, intitulé, échéance, rappel, statut todo/done/cancel, origine manuelle/dictée/IA, créée le, modifiée le)
- **Enregistrement** (id, visite, fichier, durée, statut de transcription, date de purge)
- **Glossaire** (terme, variantes, catégorie)

## 9. Architecture envisagée [À VALIDER]

Détail dans `ARCHITECTURE.md`. Infrastructure : serveur Docker interne en UE (décision du 21/11).

- **Client** : un seul code pour iOS/Android/tablette (React Native ou Flutter) plutôt qu'une PWA : accès micro, stockage local et biométrie sont plus fiables en natif, en particulier sur iOS.
- **Back** : API REST, base PostgreSQL, stockage objet pour l'audio/photos, file de traitement pour transcription et IA.
- **Sécurité** : chiffrement local, authentification par jetons, effacement à distance, journal d'audit.

## 10. Exigences non fonctionnelles

- Démarrage de la saisie d'une visite en ≤ 3 appuis.
- Utilisable d'une main, gros éléments tactiles, mode sombre, lisible en plein soleil.
- Tablette : affichage en deux colonnes (liste + détail).
- Langues : multilingue ; liste des langues de l'interface et de la dictée à fixer. Attention : la qualité de transcription et de l'IA varie fortement d'une langue à l'autre ; chaque langue supportée doit être testée.
- RGPD : base légale, durée de conservation, droit d'accès/suppression, registre des sous-traitants (transcription, IA).

## 11. Questions ouvertes

1. Versions minimales d'iOS et d'Android : inconnues. Hypothèse de travail : iOS 17+ et Android 13+ **[À VALIDER]**.
2. Fusion de clients dans le CRM : le CRM fournit-il l'identifiant du client absorbant ? Inconnu. Par défaut : les visites restent sur l'ancien client (inactif) et un administrateur les rattache à la main.
3. Format et contenu attendus par le CRM pour récupérer visites et CR (champs, fréquence d'appel, historique initial) ?
4. Documentation complète de l'API du CRM : quotas, identifiant de référence, gestion des suppressions.
