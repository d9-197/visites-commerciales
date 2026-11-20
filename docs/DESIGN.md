# Design — v0.1 (brouillon)

## Principes
1. **Saisie minimale** : la voix est le chemin principal, le clavier le secours.
2. **Une action principale par écran**, bouton large en bas, accessible au pouce.
3. **Toujours montrer l'état** : hors-ligne, en attente de synchro, transcription en cours.
4. **L'IA propose, l'humain valide** : toute suggestion est visible, comparable, annulable.
5. **Tablette** : les mêmes écrans en deux colonnes (liste à gauche, détail à droite).

## Navigation (barre du bas)
`Aujourd'hui` · `Agenda` · `Clients` · `Actions` · `Plus`

Bouton flottant « + » : nouvelle visite / note rapide / nouveau client.

## Écrans

### 1. Aujourd'hui
```
+------------------------------+
| Jeudi 20 nov.      ● En ligne|
|------------------------------|
| Prochaine visite       10:30 |
| Dupont SA — M. Martin        |
| 12 rue des Lilas, Lyon       |
| [ Préparer ]   [ Démarrer ]  |
|------------------------------|
| Plus tard                    |
|  14:00 Atelier Roux          |
|  16:30 Groupe Bernard        |
|------------------------------|
| Actions en retard (2)        |
+------------------------------+
```

### 2. Fiche de préparation
```
+------------------------------+
| < Dupont SA                  |
| Dernière visite : 12 oct.    |
|------------------------------|
| Résumé IA (à vérifier)       |
|  - Intéressé par l'offre B   |
|  - Budget non confirmé       |
| Actions ouvertes (1)         |
|  Envoyer devis — avant 22/11 |
| Contacts : M. Martin, Mme X  |
|------------------------------|
| [        Démarrer         ]  |
+------------------------------+
```

### 3. Visite en cours
```
+------------------------------+
| Dupont SA            ⏱ 00:23 |
|------------------------------|
| 10:41  « Budget 40 k€ ... »  |
| 10:48  [photo] Tableau       |
|------------------------------|
|  ( 🎤 )  Note vocale         |
|  [Texte] [Photo]             |
|------------------------------|
| [       Terminer         ]   |
+------------------------------+
```

### 4. Compte rendu (après dictée)
```
+------------------------------+
| Compte rendu                 |
| [ Original ] [ Proposé IA ]  |
|------------------------------|
| Résumé       ✎               |
| Besoins      ✎               |
| Objections   ✎               |
| Décisions    ✎               |
| Prochaine étape  ✎           |
|------------------------------|
| Actions détectées            |
|  ☐ Devis — jeudi 27/11  [ok] |
|  ☐ Rappeler M. Martin   [ok] |
|------------------------------|
| ( 🎤 Compléter )  [ Valider ]|
+------------------------------+
```
Les passages modifiés par l'IA sont surlignés ; un appui montre le texte dicté d'origine.

### 5. Fiche client
Onglets : Infos · Contacts · Visites · Actions. Bouton « Nouvelle visite ».

### 6. Actions
Liste filtrée (en retard / aujourd'hui / à venir), glisser pour terminer ou reporter.

### 7. Paramètres
Compte, mode hors-ligne (données à garder), glossaire personnel, durée de conservation de l'audio, déconnexion.

## États à concevoir
Hors-ligne · synchro en cours · conflit · transcription en attente / échec · micro refusé · IA indisponible (le CR reste saisissable à la main) · liste vide.

## Éléments visuels
Cibles tactiles ≥ 48 px, contraste AA minimum, mode sombre, retours haptiques et visuels pendant l'enregistrement (niveau sonore, durée).
