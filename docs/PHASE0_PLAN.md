# Phase 0 : préparation — plan v0.1

Objectif : lever les risques qui peuvent changer le choix technique ou le budget, **avant** de développer le produit. À la fin de la phase, on décide : framework mobile, fournisseur de transcription et d'IA, approche de synchro, mode de distribution.

Les seuils de réussite sont des **propositions à valider** : je n'ai pas de référence vérifiée qui les fonde. Les durées sont des ordres de grandeur, à recaler avec l'équipe.

## 1. Chantiers

| # | Chantier | Décision qu'il éclaire | Dépend de |
|---|----------|------------------------|-----------|
| A | Test comparatif de transcription | Fournisseur de transcription, langues réellement couvertes | Enregistrements de test |
| B | Test de fidélité de l'IA de structuration | Fournisseur/modèle IA, garde-fous | A (textes transcrits) |
| C | Faisabilité mobile sur appareils réels | React Native ou Flutter | Appareils iOS et Android |
| D | Prototype de synchro et de droits | Synchro maison ou base répliquée | Modèle de données minimal |
| E | Distribution via NinjaOne | Mode de déploiement, configuration gérée | Accès IT / NinjaOne |
| F | Cadrage CRM, IT, RGPD | Périmètre d'intégration, versions d'OS, contrats | Interlocuteurs identifiés |

A, C, D, E et F peuvent démarrer en parallèle. B suit A.

## 2. Chantier A : transcription

**Question** : quels fournisseurs transcrivent assez bien les 6 langues, avec du bruit et du vocabulaire métier, en traitant les données dans l'UE, dans le budget ?

**Jeu de test**
- 6 langues (FR, EN, ES, IT, DE, NL) × 20 enregistrements = 120 enregistrements, de 1 à 3 minutes, soit environ 4 à 6 heures d'audio.
- Variété : dictée en voiture (moteur, route), en extérieur, en bureau calme ; débit rapide et lent ; accents ; noms de clients, produits et acronymes réels, et nombres (budgets, dates).
- Source : commerciaux volontaires dictant un compte rendu **fictif ou anonymisé**. Pas d'enregistrement de vrais clients ni de conversations ; consentement écrit des volontaires.
- Référence : transcription faite à la main par un locuteur de chaque langue (effort estimé à plusieurs fois la durée de l'audio ; à planifier).

**Candidats** : trois, parmi ceux du comparatif (`COMPARATIF_FOURNISSEURS.md`) : un fournisseur européen, un grand cloud en zone UE, un spécialiste de la transcription. Confirmer d'abord par écrit pour chacun le traitement dans l'UE ; écarter ceux qui ne le garantissent pas.

**Mesures**
- Taux d'erreur de mots par langue et par condition (après normalisation commune de la ponctuation et de la casse).
- Taux d'erreur sur les **nombres et noms propres** (critique pour un compte rendu).
- Effet d'un glossaire/vocabulaire personnalisé, s'il existe chez le fournisseur.
- Temps de traitement d'un enregistrement de 2 minutes.
- Coût réel pour 10 h d'audio par mois.

**Livrable** : tableau de résultats par fournisseur, langue et condition ; recommandation écrite.

**Critères de réussite (à valider)**
- Au moins un fournisseur dont les erreurs sur les nombres et noms propres sont assez faibles pour qu'une relecture rapide suffise, dans **chacune** des 6 langues. Valeur seuil à fixer avec les commerciaux avant le test, par exemple à partir de ce qu'ils jugent acceptable à relire.
- Traitement UE confirmé par écrit.
- Coût de transcription compatible avec la part du budget de 30 €/mois réservée à la voix.
- Si aucune langue ne passe pour un fournisseur : décider entre un second fournisseur pour cette langue, la dictée native, ou la retirer du lancement.

## 3. Chantier B : fidélité de l'IA

**Question** : le modèle structure-t-il le compte rendu sans rien inventer, dans les 6 langues, à un coût acceptable ?

**Méthode** : appliquer le traitement (nettoyage, champs du compte rendu, extraction d'actions et d'échéances) aux transcriptions de A (version de référence, pour isoler l'effet de l'IA), puis aux sorties du meilleur transcripteur.
- Relecture humaine de chaque sortie avec une grille : information inventée, information omise, nombre ou nom modifié, échéance mal interprétée, action manquée ou en trop.
- Contrôle automatique : chaque nombre et nom propre du résultat figure-t-il dans la dictée ?
- Jeu de cas pièges : dates relatives (« jeudi prochain »), montants en lettres, deux clients cités, phrase incomplète, dictée très courte, mélange de langues.
- Coût et durée par compte rendu, pour 40 visites par mois.

**Critères de réussite (à valider)**
- Aucune information inventée jugée grave (chiffre, client, engagement) sur le jeu de test ; tout écart restant doit être détecté par le contrôle automatique ou visible dans la comparaison avec l'original.
- Échéances relatives correctement interprétées dans les 6 langues, ou signalées « à préciser ».
- Coût total transcription + IA par utilisateur nettement sous 30 €/mois avec marge, dans l'hypothèse de 10 h d'audio.
- Traitement UE confirmé par écrit pour le service IA retenu.

**Livrable** : rapport d'erreurs par catégorie et par langue ; version initiale des consignes (modèle de compte rendu, glossaire).

## 4. Chantier C : faisabilité mobile

**Question** : React Native tient-il les exigences sur iOS et Android, sinon Flutter ?

Réaliser un même **petit prototype** par framework si le premier échoue (commencer par React Native). Prototype minimal : un écran de visite avec enregistrement, une base locale chiffrée, une notification locale, la lecture d'une configuration.

**Tests sur appareils réels (au moins un iPhone, un Android, une tablette de chaque, du parc cible)**
1. Enregistrement audio continu de 10 minutes, écran verrouillé et application en arrière-plan.
2. Reprise après interruption (appel entrant, notification système, coupure du micro).
3. Perte de réseau pendant l'envoi d'un fichier audio ; reprise sans doublon.
4. Base locale chiffrée : lecture et écriture avec un volume réaliste (par exemple plusieurs milliers de visites et de notes) ; temps d'ouverture d'une fiche.
5. Notification locale d'action programmée, application fermée, appareil redémarré.
6. Lecture de la configuration poussée par le MDM (voir chantier E).
7. Déverrouillage biométrique et stockage des jetons.
8. Affichage correct sur tablette (deux colonnes).

**Critères de réussite** : les points 1 à 5 passent sur les deux systèmes avec le framework testé. Un échec sur le point 1 ou 4 est éliminatoire ; sur les autres, évaluer si un contournement raisonnable existe.

**Livrable** : tableau des résultats par appareil ; décision du framework, avec liste des bibliothèques retenues et leur état de maintenance.

## 5. Chantier D : synchro et droits

**Question** : peut-on assurer la synchro hors-ligne et la visibilité par hiérarchie avec notre propre code à un coût raisonnable ?

**Prototype** : un back minimal (PostgreSQL) et un client de test avec :
- tables clients, visites, comptes rendus, notes (dont privées), actions, hiérarchie, affectations ;
- envoi d'opérations rejouables et réception par compteur de changements, avec suppressions logiques ;
- règle de visibilité à deux modes, appliquée au back.

**Scénarios à rejouer automatiquement**
1. Deux appareils modifient le même champ hors-ligne ; reconnexion ; résultat conforme à la règle.
2. Deux appareils modifient le même texte de compte rendu : les deux versions sont conservées.
3. L'opération est envoyée deux fois : aucun doublon.
4. Un commercial est retiré d'un client ou le mode de visibilité change : les données concernées disparaissent de son appareil à la synchro suivante.
5. Un manager et un directeur voient exactement ce que la règle prévoit, ni plus ni moins.
6. Une note privée n'apparaît jamais ailleurs que chez son auteur, y compris dans l'API prévue pour le CRM.
7. Reprise après coupure réseau au milieu d'une synchro.
8. Volume : 200 utilisateurs simulés synchronisant en même temps.

**Critères de réussite** : les 8 scénarios passent ; le code de synchro reste de taille et de complexité acceptables pour l'équipe. Sinon, évaluer une base répliquée clé en main sur les mêmes scénarios, en vérifiant en particulier l'hébergement UE et la visibilité par hiérarchie.

**Livrable** : prototype et suite de tests réutilisables ; décision synchro maison ou clé en main ; schéma de données révisé.

## 6. Chantier E : distribution via NinjaOne

**Questions à trancher avec l'IT et NinjaOne** (je n'ai pas vérifié ce qu'il permet) :
- Quels appareils mobiles sont gérés (iOS, Android, versions) ?
- Comment déployer une application privée (stores en mode privé, fichier signé, autre) ?
- Peut-on pousser une configuration d'application (adresse du back, paramètres) ?
- Peut-on imposer des politiques (code d'écran, chiffrement) et effacer un appareil à distance ?
- Comment distribuer les versions de recette avant production ?

**Essai** : déployer une application de test sur 2 à 3 appareils du parc par la voie prévue, lire une configuration poussée, effectuer une mise à jour.

**Critères de réussite** : une voie de déploiement documentée et reproductible pour iOS et Android, y compris pour les versions de recette ; si la configuration gérée n'est pas disponible, prévoir un autre moyen (écran de configuration sécurisé).

**Livrable** : procédure de déploiement ; versions minimales d'OS confirmées (ferme la question ouverte n° 1 de la spec).

## 7. Chantier F : cadrage externe

| Sujet | Interlocuteur | Obtenir |
|-------|---------------|---------|
| API du CRM | Équipe CRM | Documentation, authentification, champs, quotas, identifiant de référence, gestion des suppressions et fusions, format attendu pour récupérer visites et CR |
| Parc et MDM | IT | Versions d'OS, modèles, processus de déploiement |
| Contrats et conformité | Protection des données, juridique | Contrats de sous-traitance des fournisseurs retenus, base légale, durées de conservation, nécessité d'une analyse d'impact |
| Hébergement | IT, achats | Fournisseur cloud UE, exigences de sécurité |
| Utilisateurs | Commerciaux et managers pilotes | 5 à 8 personnes pour le test A et la revue des maquettes |

**Livrable** : réponses écrites ; mise à jour de la section « Questions ouvertes » de la spec.

## 8. Calendrier indicatif

Hypothèse : une petite équipe, chantiers menés en parallèle. À recaler.

| Semaine | A | B | C | D | E | F |
|---------|---|---|---|---|---|---|
| 1 | Constitution du jeu de test, accords fournisseurs | | Prototype RN | Schéma + back minimal | Demande d'accès | Envoi des questions |
| 2 | Enregistrements, transcriptions de référence | | Tests appareils | Scénarios 1 à 4 | Essai de déploiement | Relances |
| 3 | Exécution des fournisseurs, mesures | Préparation | Décision framework | Scénarios 5 à 8 | Procédure | Contrats |
| 4 | Analyse, recommandation | Exécution IA, relecture | | Décision synchro | | |
| 5 | | Rapport, coûts | | | | |

Marge à prévoir : la transcription de référence à la main et la disponibilité des commerciaux volontaires sont les deux goulots probables, la durée totale peut donc aller de 4 à 6 semaines.

## 9. Décisions en fin de phase

| Décision | Basée sur |
|----------|-----------|
| Framework mobile | Chantier C |
| Fournisseur de transcription et langues du lancement | Chantier A |
| Fournisseur IA et garde-fous | Chantier B |
| Synchro maison ou clé en main | Chantier D |
| Distribution et versions d'OS minimales | Chantier E |
| Périmètre de l'intégration CRM, besoins de contrats | Chantier F |
| Budget réel par utilisateur | A et B |
| Go / no-go du lancement de la phase 1 | Synthèse |

## 10. Ce qu'il faut de votre côté pour démarrer

1. Des commerciaux volontaires (pour dicter les enregistrements de test), au moins 1 locuteur par langue, avec leur accord écrit.
2. Des locuteurs pour relire/transcrire la référence dans chaque langue.
3. Des appareils de test iOS et Android, dont une tablette de chaque, du parc cible.
4. Un contact IT/NinjaOne et un accès pour l'essai de déploiement.
5. Un contact côté CRM et côté protection des données.
6. Des comptes d'essai chez les fournisseurs candidats, avec confirmation écrite du traitement dans l'UE.
