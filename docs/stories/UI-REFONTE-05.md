# UI-REFONTE-05 — Routines sur iPhone : les pastilles disent le programme, « 3 sur 5 cette semaine », la synthèse de la semaine

Module : M4 Routines · Palier : refontes après la 1.0.2, quatrième des huit dans l'ordre d'Ali du 2026-10-27 · Agent : routines avec ui-design-system · Ouverte le 2026-10-28 par Claude Code.

Statut : **ouverte, passe product-owner écrite.** Estimation : 5 à 7 h actives ; alerte à 10 h.

Références : `docs/maquettes-refonte/Routines-v2.html`, huit règles transversales du README du même dossier. Écran de départ : `src/features/routines/RoutinesScreen.tsx`, `RoutineCard.tsx` (+ `.css`), `RoutinesScreen.css`, textes `src/i18n/fr.routines.ts` / `en.routines.ts`, formats `src/i18n/formatRoutine.ts`, domaine `src/domain/routineSchedule.ts` (`weekRounds`, `weekCounter`). Écran à la demande (`lazyScreens.tsx`). **Périmètre : la mise en page iPhone** (`useLayout() === 'mobile'`) ; la grille PC (PC-Routines.html) ne change pas, hors le libellé « Modifier » commun aux deux.

## Passe product-owner

### Ce que la maquette change (et ce qu'elle ne change pas)

Les sept pastilles L M M J V S D existent déjà avec leurs trois états (pointillé = non prévu, contour = prévu, plein = fait) : la maquette les garde et retire ce qui les parasitait. Le compteur « 0/0 » à droite des pastilles devient une phrase dans la ligne d'informations, « 3 sur 5 cette semaine » ; la fréquence s'écrit en toutes lettres (« du lundi au vendredi », « mardi et vendredi », « tous les jours ») au lieu de « lun., mer., ven. » ; l'icône et la petite horloge quittent la carte (le titre seul, en 19 px) ; « Éditer » devient « Modifier », au trait. Sous le titre « Routines », une **ligne de synthèse** : « Semaine du 19 au 25 oct. · 7 sur 10 faites », filet simple ; plus de filet décoratif ni de bascule « Vue compacte » sur iPhone. La phrase d'aide (« Gérez vos routines ici… ») sort de la zone de contenu : elle disparaît de l'écran iPhone (règle du README : l'aide hors de la zone de contenu ; l'état vide garde son propre texte). Le bas de l'écran devient une rangée : « Rapport du mois » au trait (pleine largeur) et un bouton plein « Routine » avec un « + » (libellé accessible « Ajouter une routine », inchangé). Rien n'est retiré : validation d'un jour sur les pastilles (R-03), rapport de la routine au toucher du corps de la carte (R-06), formulaire, pause et archivage (R-05), séries (R-04), routines archivées, ligne « Rappels décalés » (N-FIX-04) restent.

### Écarts avec le PRD et les maquettes, assumés

| Source | Formulation | Choix de la story |
| --- | --- | --- |
| R-01 (fiche) | « compteur faits / prévus de la semaine » (« 2/7 ») | même compteur, écrit « 2 sur 7 cette semaine » dans la ligne d'informations (c'était déjà son libellé accessible) ; PC inchangé (« 2/7 ») |
| A-06 | « Vue compacte » sur chaque liste | retirée de l'écran iPhone (la maquette n'en a pas) ; le réglage reste pour le PC ; sur iPhone les cartes sont toujours complètes |
| R-01 | icône de la routine sur la carte | plus d'icône sur la carte iPhone (maquette) ; elle reste dans le formulaire et le rapport de la routine (l'agenda d'Aujourd'hui l'a déjà retirée, UI-REFONTE-02) |
| Maquette | « Modifier » | adopté pour les deux mises en page (libellé accessible « Modifier la routine {titre} ») : un seul verbe dans l'app pour le formulaire |
| Maquette | aucune phrase d'aide | retirée sur iPhone ; l'état vide (« Aucune routine pour l'instant ») et le bouton « Routine » suffisent |

À ajouter à PRD-02 : R-01 (forme du compteur), A-06 (Routines iPhone).

### Critères

1. **En-tête** : titre « Routines » (Fraunces, 42 px) ; dessous, `.ct-routines__summary` : « Semaine du 28 sept. au 4 oct. · 3 sur 9 faites » (même mois : « Semaine du 19 au 25 oct. »), somme des compteurs `weekCounter` des routines affichées (filtre courant), singulier « 1 sur 1 faite » ; aucune routine prévue mais des routines : « Aucune routine prévue cette semaine » ; aucune routine : pas de synthèse (état vide). Filet simple sous la synthèse ; plus de filet décoratif ni de bascule « Vue compacte » sur iPhone ; pastilles Tout / Pro / Perso dessous.
2. **Carte** (iPhone) : titre 19 px gras (bouton qui ouvre le rapport, inchangé), bouton « Modifier » au trait à droite (libellé « Modifier la routine {titre} ») ; aucune icône, aucune horloge ; sept pastilles (états et actions inchangés : `data-state`, `aria-checked`, `aria-disabled`, libellés « Lundi, fait », « Mardi, non prévu ») **sans compteur à leur droite** ; ligne d'informations `.ct-routine-card__info` : « 22:30 · Perso · du lundi au vendredi · 3 sur 5 cette semaine » (heure si elle existe, espace sous « Tout », fréquence en toutes lettres, « En pause », série en cours, puis le compteur `.ct-routine-card__counter` avec son libellé accessible actuel). Toucher le corps de la carte ouvre le rapport (inchangé). Ligne « Rappels décalés » inchangée.
3. **Fréquence en toutes lettres** (`scheduleSentence`, catalogue à la demande) : « tous les jours » ; jours choisis : suite de 3 jours consécutifs ou plus → « du lundi au vendredi », sinon « lundi, mercredi et vendredi » (« et » avant le dernier) ; « 3 fois par semaine » ; « tous les 3 jours » ; « toutes les 2 semaines, le mardi et le jeudi ». PC : `scheduleShort` inchangé.
4. **Bas de l'écran** (iPhone) : rangée collée au bas, filet au-dessus : « Rapport du mois » (bouton au trait, prend la largeur) et « Routine » (bouton plein avec « + », libellé accessible « Ajouter une routine », ouvre la feuille Ajout au segment Routine comme aujourd'hui) ; plus de bouton flottant.
5. **Aide** : plus de paragraphe « Gérez vos routines ici… » sur iPhone ; l'état vide garde son texte et son bouton.
6. **Sombre** : jetons existants (`routineTokens.css`, bordures, encre) ; aucune paire nouvelle.
7. **Largeur et zone de sécurité** : rangée du bas au-dessus de `--ct-safe-area-bottom`, rien de plus large que l'écran (`expectFitsViewport`).
8. **Bundle** : écran à la demande ; textes nouveaux dans `src/i18n/routinesRefonteText.ts` (synthèse, fréquences en toutes lettres, « Routine ») ; `routines.edit` / `editLabel` changent de valeur dans le départ à taille égale ; aucun module nouveau dans `start-modules.json` ; mesure avant push et sur `main` après fusion.
9. **PC** : aucune différence de rendu ni de test hors « Modifier ».

### Preuves attendues

- **Rouge d'abord** (commit de tests seuls) : `src/features/routines/RoutinesRefonte.test.tsx` (synthèse et ses formes, bascule absente, carte sans icône ni horloge, « Modifier », pastilles sans compteur, ligne d'informations complète, aide absente, rangée du bas, PC inchangé) ; e2e `tests/e2e/UI-REFONTE-05.spec.ts` sur `iphone` et `iphone-webkit` (synthèse, cartes, rangée du bas, sombre, largeur).
- **Vert ensuite** : suites `routines` (Vitest) avec adaptations tracées (`RoutinesScreen.test`, `RoutineValidation.test`, `RoutineEveryN.test`, `RoutineReport.test`, `RoutineTime.test`, `RoutineStreaks.test`, `RoutinePauseArchive.test`, `RoutineQuietShift.test`, `qaRoutinesLot.test` : « Modifier la routine », compteur en phrase, aide absente) ; e2e `R-01` à `R-07`, `parcours/J04`, `ES-0x` et `capture.spec` (maquette `Routines-v2.html`) adaptés ; lint ; typage ; garde du bundle ; CI complète.

### Hors périmètre

Les quatre autres refontes ; le PRD ; le formulaire, le rapport de routine et le rapport du mois ; la grille PC.

## Passe agent du module

À écrire après la preuve rouge.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

À écrire.
