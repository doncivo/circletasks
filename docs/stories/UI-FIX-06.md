# UI-FIX-06 — Concentration : titre français, Pause dominante, total du jour vivant (défaut 13)

Module : M10 Focus Time · Palier : après la 1.0 par la règle de tri (défaut visible), avancé par Ali dans l'ordre du 27 octobre 2026 après UI-FIX-05 · Agent : focus-time · Ouverte le 2026-10-27 par Claude Code.

Statut : **ouverte, preuves rouges écrites, aucun code**. Estimation : 2 h actives ; alerte à 3 h.

## Demande d'Ali (liste du 27 octobre 2026, défaut 13)

« Focus Time devient un titre français sans capitales ; Pause domine visuellement Terminer la tâche ; le total du jour ne reste plus à zéro pendant une première minute active (secondes ou minute entamée). »

## Constat (code de `main`)

- L'en-tête de l'écran de session est « FOCUS TIME » (`focus.heading`, fr et en).
- Pendant la session, « Terminer la tâche » est le bouton plein (`ct-focus__button--finish`, fond coloré) et Pause le bouton au trait : l'action destructrice domine. Règle 6 des maquettes de refonte : « l'action destructrice descend, s'annonce et n'est jamais la seule action visible ».
- Le pied « Aujourd'hui : … de concentration » ne compte que les sessions **terminées** (`state.today`, F-03) : pendant la première session du jour, il affiche « 0 min » du début à la fin ; la session active n'est jamais comptée avant sa clôture, même après dix minutes.

## Critères

1. En-tête : « Concentration » en français, « Focus » en anglais ; aucune capitale forcée par la feuille de style.
2. Pendant la session (en cours ou en pause) : Pause, puis Reprendre, porte le style plein (`ct-focus__button--primary`, fond `--ct-focus-on`) ; « Terminer la tâche » est au trait. Session terminée : inchangé, « Terminer la tâche » reste l'action principale.
3. Pied de l'écran : le temps actif de la session en cours s'ajoute aux sessions terminées, relu chaque seconde (le tic existant). Sans session terminée : « Aujourd'hui : 42 s de concentration » sous la minute, puis « Aujourd'hui : 1 min de concentration · session en cours » ; avec des sessions terminées : « Aujourd'hui : 27 min de concentration · 1 session · en cours ». Le temps de pause ne compte pas. À l'instant du lancement (0 s) et sans session active, les textes historiques restent.
4. Rien d'écrit en base : le total persistant (F-03) reste celui des sessions terminées ; la fiche de tâche et le rapport ne changent pas.
5. Textes dans `fr.focus.ts` et `en.focus.ts`.

## Preuves

- **Rouge** (commit avant tout code) : `src/features/focus/FocusConcentration.test.tsx` (en-tête, style des boutons dans les trois phases, pied vivant à 0 s, 42 s, 90 s, en pause, avec sessions terminées, terminé) ; `src/i18n/formatFocusLive.test.ts` (`formatFocusTodayLive`, fr et en).
- **Vert** : à consigner, avec les adaptations des tests historiques du pied (F-03 critère 2 : « 0 min » n'est vrai qu'à 0 s de session active).

## Passes

- Product-owner : critères ci-dessus.
- Agent du module, QA, code-reviewer : à consigner.
