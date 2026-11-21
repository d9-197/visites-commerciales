# Phase 0 : préparation — plan réduit v0.2

**Contexte (21/11/2026)** : les ressources du plan complet (volontaires pour dicter, locuteurs pour les références, appareils de test, accès IT) ne peuvent pas être mobilisées. NinjaOne et la distribution des applications sont hors périmètre de ce projet-ci. L'infrastructure sera un serveur Docker (voir `ARCHITECTURE.md` §15).

Le plan complet reste dans `PHASE0_PLAN_COMPLET.md`. Ce document garde ce qui reste faisable, et remplace les tests qui exigent des ressources par des garde-fous et une mesure en conditions réelles.

## 1. Ce que ce changement coûte, sans détour

Sans test préalable de transcription et d'IA, on ne saura **pas avant de développer** si la qualité suffit dans chacune des 6 langues. Ce risque n'est pas supprimé, il est déplacé : on le découvre pendant le pilote, avec de vraies dictées, au lieu de le découvrir avant. Pour qu'il reste supportable :
- le fournisseur doit rester **interchangeable** (adaptateurs) ;
- le lancement doit se faire **langue par langue**, chaque langue étant ouverte seulement quand sa qualité mesurée est jugée suffisante ;
- l'application doit **mesurer la qualité elle-même** (§3).

De même, sans appareils de test, le choix React Native reste une hypothèse : le premier jalon de développement doit être le test de l'enregistrement audio en arrière-plan (§4).

## 2. Chantiers conservés

| # | Chantier | Ressources | Livrable |
|---|----------|-----------|----------|
| D | Prototype de synchro et de droits | Développeurs, base PostgreSQL (conteneur) | Prototype + 8 scénarios automatisés |
| G | Sélection documentaire des fournisseurs | Lecture, courriels aux fournisseurs | 2 candidats par fonction, traitement UE confirmé par écrit |
| H | Instrumentation de la qualité | Développeurs | Métriques intégrées au produit (§3) |
| C' | Premier jalon mobile | Un iPhone et un Android de développement | Test de l'audio en arrière-plan (§4) |
| F | Questions écrites (CRM, protection des données, hébergement) | Envoi de courriels, aucune mobilisation | Réponses, mise à jour des questions ouvertes |

Supprimé : chantier E (NinjaOne). Remplacés : chantiers A et B (tests avec volontaires) par G et H.

## 3. Mesure de la qualité intégrée au produit (H)

Principe : l'application garde la dictée, la proposition de l'IA et la version validée. L'écart entre les deux dernières mesure la qualité sans transcription de référence manuelle.

Mesures, par langue et par utilisateur, remontées au back (sans exposer le contenu aux autres utilisateurs) :
- part des comptes rendus validés **sans modification** de la proposition de l'IA ;
- proportion de texte modifiée (distance d'édition entre proposition et version finale) ;
- nombre de **chiffres, dates et noms propres modifiés** à la relecture (indicateur d'erreurs graves) ;
- bouton « signaler une erreur » avec catégorie (mot mal compris, chiffre faux, information inventée, action manquée) ;
- durée de relecture ; part des dictées abandonnées (retour à la saisie manuelle) ;
- coût réel par compte rendu et par utilisateur ; délais de traitement.

Limite : ces mesures montrent ce que les utilisateurs corrigent, pas ce qu'ils laissent passer par inattention. Un contrôle par sondage reste souhaitable : un responsable relit quelques comptes rendus par semaine et par langue.

**Seuils d'ouverture d'une langue** : à fixer avant le pilote avec les utilisateurs, par exemple un taux maximal de corrections graves. Je ne propose pas de valeur : elle doit venir de ce que les commerciaux jugent acceptable.

## 4. Premier jalon mobile (C')

Avant d'investir dans l'interface, un prototype minimal de quelques jours vérifie, sur un iPhone et un Android de développement :
1. enregistrement audio de 10 minutes, écran verrouillé et application en arrière-plan ;
2. reprise après appel entrant ;
3. envoi de fichier avec coupure réseau, sans doublon ;
4. base locale chiffrée avec un volume réaliste ;
5. notification locale d'une action, application fermée.

Si un de ces points échoue avec React Native, basculer sur Flutter avant d'aller plus loin. Les tests sur tablette et sur plus d'appareils se feront au début du pilote.

## 5. Sélection documentaire des fournisseurs (G)

- Retenir **deux candidats** de transcription et **deux** d'IA à partir de `COMPARATIF_FOURNISSEURS.md`, après vérification dans la documentation officielle (le comparatif repose sur des sources tierces).
- Obtenir par écrit : traitement dans l'UE (y compris sauvegardes et journaux), contrat de sous-traitance, durée de conservation, absence d'entraînement sur vos données, liste des langues réellement prises en charge, tarifs.
- Écarter ceux qui n'apportent pas ces garanties.
- Mettre en œuvre le premier candidat et garder le second prêt derrière la même interface.

## 6. Prototype de synchro et de droits (D)

Inchangé (voir `PHASE0_PLAN_COMPLET.md` §5) : 8 scénarios automatisés rejoués sur un back minimal en conteneurs. Le scénario de volume (200 utilisateurs simulés) se fait avec des clients simulés, sans appareils.

## 7. Cadrage écrit (F)

Questions à envoyer, sans réunion obligatoire :
- **CRM** : authentification, champs client/contact, quotas, identifiant de référence, format attendu pour récupérer visites et CR, identifiant du client absorbant lors d'une fusion, accès réseau entre le serveur et le CRM.
- **Protection des données** : nécessité d'une analyse d'impact, durées de conservation, base légale, information des utilisateurs.
- **Hébergement** : voir les questions du §15 de l'architecture.

## 8. Calendrier indicatif

À recaler ; hypothèse d'une petite équipe de développement.

| Semaine | D | G | H | C' | F |
|---------|---|---|---|----|---|
| 1 | Schéma, back minimal | Vérification des documentations | Définition des métriques | Prototype audio | Envoi des questions |
| 2 | Scénarios 1 à 4 | Demandes écrites aux fournisseurs | | Tests iPhone/Android | Relances |
| 3 | Scénarios 5 à 8 | Choix des 2 candidats | Spécification des écrans de signalement | Décision framework | |

Durée indicative : 3 semaines, hors délais de réponse des fournisseurs et des équipes CRM.

## 9. Décisions en fin de phase

| Décision | Basée sur |
|----------|-----------|
| Framework mobile (provisoire jusqu'au pilote sur plus d'appareils) | C' |
| Candidats de transcription et d'IA | G |
| Synchro maison ou clé en main | D |
| Périmètre de l'intégration CRM | F |
| Démarrage de la phase 1 | Synthèse |

Les décisions suivantes passent à la phase de pilote : langues ouvertes, fournisseur définitif, budget réel par utilisateur.
