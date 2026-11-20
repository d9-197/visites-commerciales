# Comparatif transcription et IA — v0.1 (20/11/2026)

**Fiabilité : faible à moyenne.** Les chiffres viennent de recherches web, surtout de blogs et comparateurs tiers, souvent contradictoires. Rien n'a été vérifié sur les pages officielles des fournisseurs, et aucun test de qualité n'a été fait. Ce document sert à choisir quoi tester, pas à décider.

## 1. Critères
Traitement dans l'UE (contractuel), 6 langues (FR, EN, ES, IT, DE, NL), coût dans le budget de 30 €/utilisateur/mois, contrat de sous-traitance (DPA), qualité sur vocabulaire métier.

## 2. Transcription (tarifs publics rapportés)

| Fournisseur | Tarif rapporté | UE | Langues | Réserves |
|-------------|----------------|----|---------|----------|
| Mistral Voxtral (Mini Transcribe) | 0,0035 $/min (≈ 0,21 $/h) en batch ; temps réel 0,006 à 0,008 $/min selon la source | Une seule source (review) évoque une API hébergée dans l'UE ; rien de officiel trouvé | « 50+ langues » (annonce Mistral) ; FR, EN, ES cités comme points forts | Produit annoncé en préversion publique ; hébergement UE et NL/IT/DE à confirmer |
| Azure Speech | ≈ 0,18 $/h batch, 0,36 $/h rapide, ≈ 1 $/h temps réel (région US, agrégateurs) | Régions UE existent dans Azure ; tarifs UE non trouvés | Non vérifié | Tarifs tiers ; différences de prix selon la région |
| OpenAI gpt-4o-mini-transcribe | ≈ 0,003 $/min (≈ 0,18 $/h), tarif de l'API directe | Non trouvé ; la voie Azure OpenAI en zone UE reste à vérifier | Non vérifié | Tarif de l'API directe, pas celui d'Azure |
| AssemblyAI | ≈ 0,21 $/h batch | Point d'accès UE ; surcoût de 0 à 10 % selon les sources | Non vérifié pour NL/IT/DE/ES | Options facturées en plus |
| Deepgram (Nova-3) | ≈ 0,26 $/h batch | Point d'accès UE | ≈ 63 langues en streaming ; les 6 langues non confirmées | Options facturées en plus |
| Speechmatics | 0,12 à 0,38 $/h selon l'offre | Point d'accès UE | 55+ langues ; les 6 non confirmées | Prix rapportés de façon incohérente |

## 3. IA de structuration (LLM)
- L'API directe d'Anthropic ne propose pas de région UE (selon les sources, seule la résidence « us » est disponible) ; le traitement UE passe par des plateformes cloud, par exemple Amazon Bedrock, avec un surcoût d'environ 10 % rapporté.
- Disponibilité en région UE des derniers modèles : **sources contradictoires**, à vérifier auprès d'AWS avant tout engagement.
- Alternatives à examiner de la même façon : Mistral (éditeur européen), modèles disponibles via Azure en zone UE.

## 4. Estimation de coût (calcul personnel, hypothèses ci-dessous)

Hypothèses : 10 h d'audio/mois/utilisateur ; ≈ 140 mots/min, soit ≈ 84 000 mots ≈ 120 000 jetons de texte par mois ; le traitement IA envoie ce texte et renvoie un volume comparable, avec quelques passages supplémentaires (relecture, fiches de préparation).

| Poste | Ordre de grandeur mensuel par utilisateur |
|-------|-------------------------------------------|
| Transcription | ≈ 2 à 5 $ (0,2 à 0,5 $/h × 10 h) |
| IA (LLM) | probablement moins de 2 à 5 €, même avec plusieurs passages |
| **Total** | **très probablement bien sous 30 €** |

Conclusion prudente : **le budget ne semble pas être la contrainte principale**. Les vrais critères discriminants sont le traitement dans l'UE (à prouver par contrat) et la qualité sur 6 langues, notamment le néerlandais, l'italien et le vocabulaire métier. L'estimation devra être refaite avec des tarifs officiels et des durées réelles.

## 5. Recommandation de test
1. Constituer un jeu de test : une vingtaine d'enregistrements réels (bruit de voiture, couloir) par langue, avec la transcription de référence faite à la main.
2. Comparer 3 candidats : Mistral, Azure (zone UE) et un des spécialistes (Speechmatics ou Deepgram). Mesurer le taux d'erreurs de mots, la gestion des noms propres/jargon et le temps de traitement.
3. Pour chacun, obtenir par écrit : le traitement exclusivement dans l'UE, le DPA, la durée de conservation des données, l'absence d'entraînement sur nos données.
4. Pour l'IA, tester la fidélité du texte structuré (aucun chiffre ou nom inventé) sur ces mêmes enregistrements.

## 6. Sources consultées
- [Mistral – Voxtral](https://mistral.ai/news/voxtral/) et [Voxtral 3](https://mistral.ai/news/voxtral-3/)
- [Reflekt Lab – Voxtral 3](https://reflektlab.ai/blog/voxtral-3/) (source de l'hébergement UE, non officielle)
- [Speech-to-Text API pricing (2026)](https://www.developersdigest.tech/models/speech/speech-to-text) ; [toolradar](https://toolradar.com/guides/speech-to-text-api-pricing-compared) ; [Azure Speech (2026)](https://www.developersdigest.tech/models/speech/azure)
- [AssemblyAI – pricing guide](https://www.assemblyai.com/blog/speech-to-text-api-pricing) ; [Speechmatics – comparatif](https://www.speechmatics.com/company/articles-and-news/best-speech-to-text-ai-guide-apis-platforms-and-services-compared)
- [Claude en UE](https://kontinent.ai/en/blog/claude-in-the-eu-four-ways-compared) ; [Claude EU data residency](https://www.satoriml.com/blog/claude-eu-data-residency) ; [Claude on Bedrock EU](https://kevinwelter.com/en/blog/claude-aws-bedrock)
