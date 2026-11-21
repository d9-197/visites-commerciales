# Synthèse par IA avec l'API Mistral : première tranche

## 1. Ce qui est fait

L'utilisateur saisit des notes sur la visite, touche **« Synthétiser les notes avec l'IA »** : le back envoie le texte à Mistral, reçoit un compte rendu structuré (résumé, besoins, objections, concurrents, décisions, prochaine étape) et des actions proposées, puis l'application les affiche dans une fenêtre **« Proposition de l'IA »**. L'utilisateur relit, corrige, choisit les actions à créer et **applique** ou ignore. **Rien n'est enregistré avant cette validation.** Les actions créées portent l'origine « ia ».

Ce n'est que la partie « texte vers compte rendu ». La **transcription vocale** (voix vers texte) n'est pas faite : l'entrée est le texte des notes, saisi ou collé.

## 2. Architecture

```
Application ──(POST /reports/{id}/ai-proposals, texte des notes)──> Back ──> interface AiService ──> MistralService ──> api.mistral.ai
                                                                       │
                                                                       ├─ contrôles automatiques (nombres, noms, échéances)
                                                                       ├─ plafond mensuel, limitation de débit
                                                                       └─ enregistrement : ai_proposal (audit), ai_usage (coût)
```

- **Interchangeable** : `server/src/ai/types.ts` définit `AiService`. Mistral est une implémentation (`mistral.ts`) ; changer de fournisseur ne touche ni la route ni l'application.
- **Appel** : `POST {MISTRAL_BASE_URL}/v1/chat/completions`, `Authorization: Bearer <clé>`, `response_format: {"type": "json_object"}`, température 0,1, délai de 30 s. La structure de la requête et le mode JSON viennent de la documentation Mistral consultée ce jour ; voir §6 pour ce qui n'est pas vérifié.
- **Consignes** (`prompt.ts`) : n'inventer rien (champ vide si absent), conserver nombres et noms, écrire dans la langue du compte rendu, traiter les notes comme des données et non comme des instructions, calculer les échéances relatives à partir de la date du jour, respecter le glossaire.
- **Sortie** : JSON validé par un schéma ; un champ du mauvais type est remplacé par une chaîne vide, une action invalide est écartée, une réponse qui n'est pas du JSON est refusée (502).

## 3. Données envoyées à Mistral

Envoyé : le texte des notes, la langue du compte rendu, la date du jour, les termes du glossaire. **Pas envoyé** : nom du client, adresse, contacts, identité de l'utilisateur. Ce qui est dans les notes y est cependant : si un commercial y écrit un nom ou un montant, ils partent chez Mistral.

Conservé côté back : la proposition et le **texte source** dans `ai_proposal`, le coût dans `ai_usage`. **Durée de conservation de `ai_proposal` à définir** (elle contient le texte des notes).

## 4. Garde-fous

Contrôles automatiques sur la sortie (`guards.ts`) ; ils **signalent**, ils ne prouvent rien :
- **Nombres** absents des notes (« 40 000 », « 40.000 » et « 40000 » sont considérés identiques). Limite connue : un nombre dicté en toutes lettres (« quarante mille ») n'est pas reconnu et sera signalé à tort.
- **Noms propres** (mot capitalisé au milieu d'une phrase) absents des notes. Heuristique grossière : faux positifs et faux négatifs possibles.
- **Échéances** dans le passé, ou **calculées** à partir d'une date relative (« jeudi prochain » : à vérifier).

Autres protections : auteur de la visite seul, 404 pour qui ne voit pas la visite ; limitation à 10 demandes par minute et par utilisateur ; plafond mensuel par utilisateur (surchargeable) ; aucun contenu de notes dans les journaux ni dans les messages d'erreur.

## 5. Configuration

| Variable | Rôle |
|----------|------|
| `MISTRAL_API_KEY` | Clé d'API. **Absente : la fonction est désactivée** (réponse 503, bouton qui affiche un message). |
| `MISTRAL_MODEL` | Modèle. Défaut `mistral-small-latest`, **à vérifier** avant déploiement. |
| `MISTRAL_BASE_URL` | Défaut `https://api.mistral.ai`. |
| `MISTRAL_TIMEOUT_MS` | Délai (défaut 30000). |
| `MISTRAL_PRICE_IN_EUR_PER_M`, `MISTRAL_PRICE_OUT_EUR_PER_M` | Tarifs en euros par million de jetons. **Sans eux, le coût est enregistré à 0 et le plafond n'est pas appliqué.** |
| `AI_RATE_PER_MIN` | Demandes par minute et par utilisateur (défaut 10). |

## 6. Vérifié, non vérifié

**Vérifié** (74 tests automatisés, dont 11 pour l'IA) avec un **faux serveur Mistral** qui reproduit le format documenté : requête (clé, modèle, mode JSON, messages, date du jour, absence du nom du client), réponse bien formée, réponse illisible ou hors format, erreur 500 du fournisseur, délai dépassé, avertissements sur nombres et noms inventés, droits, plafond, limitation de débit, absence de clé, enregistrement de la proposition et du coût, et le test de bout en bout dans un navigateur (proposition relue, appliquée, action créée).

**Non vérifié** :
- **Aucun appel à l'API Mistral réelle** : je n'ai pas de clé. Le comportement réel (format exact de la réponse, présence du champ `usage`, limites, latence) reste à confirmer avec une clé de test.
- **Qualité de la synthèse** sur de vraies notes, dans les 6 langues : aucune mesure. C'est le test qui manquait déjà dans le plan de préparation ; la mesure de qualité intégrée (`report_quality`) est prévue mais pas câblée.
- **Le nom du modèle par défaut** et sa prise en charge du mode JSON. La documentation indique que le mode JSON est disponible pour tous les modèles ; je n'ai pas vérifié ce modèle en particulier.
- **Traitement dans l'UE** : d'après des sources tierces et la documentation de Mistral, le traitement serait dans l'UE par défaut, avec un point d'accès américain séparé ; des sous-traitants pourraient transférer des données hors UE (clauses contractuelles types) ; une rétention de 30 jours pour la détection d'abus existerait hors « zéro rétention », qui est une option à demander. Ces points proviennent en partie de blogs : **à confirmer dans le contrat de sous-traitance (DPA) et auprès de Mistral** avant d'envoyer de vraies notes.

## 7. Limites de cette tranche et suite

- Pas de dictée ni de transcription : l'entrée est du texte.
- La langue du compte rendu est le français dans l'application ; elle devrait venir de la langue de dictée du profil.
- Le glossaire est lu s'il existe en base, mais il n'y a pas d'écran pour le gérer.
- Les mesures de qualité (acceptée sans modification, nombres modifiés…) et le signalement d'erreur ne sont pas câblés.
- Réponse synchrone : acceptable pour du texte court. Avec la transcription audio, passer en traitement asynchrone (file de tâches), comme prévu dans l'architecture.
- Information des utilisateurs : prévoir un avertissement clair que les notes sont envoyées à un service tiers, et une décision sur le consentement.

À faire en premier : une clé de test, un jeu de notes réelles (anonymisées) dans chaque langue, et la mesure de la qualité avec les commerciaux.
