# UI-FIX-06 — Concentration : titre français, Pause dominante, total du jour vivant (défaut 13)

Module : M10 Focus Time · Palier : après la 1.0 par la règle de tri (défaut visible), avancé par Ali dans l'ordre du 27 octobre 2026 après UI-FIX-05 · Agent : focus-time · Ouverte le 2026-10-27 par Claude Code.

Statut : **code sur la branche `ui-fix-06-concentration`, tests du module, lint et typage verts ; e2e, bundle, CI complète et fusion requises**. Estimation : 2 h actives ; alerte à 3 h.

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
- **Vert** (commit du correctif, identifiant au journal) : suites Focus et formateurs **175 tests / 17 fichiers verts** ; lint, typage ; e2e F-01 à F-04 sur `pc` et `iphone` **44 verts, 4 ignorés volontaires** ; garde du bundle **62/62, 335 397 normalisés, marge 23 003** (+141 face à UI-FIX-05 : trois textes dans `fr.focus.ts`, catalogue du départ). Adaptation avec trace : les deux tests historiques du pied (F-03 critères 1 et 2) lisaient l'horloge à 5 min de session active ; ils sont posés à l'instant du lancement (0 s active), puisqu'ils portent sur les sessions terminées ; le pied vivant a ses propres tests.

## Passes

- **Product-owner** : critères ci-dessus ; « Concentration » reprend le mot déjà employé par la ligne de la fiche et le rapport.
- **Agent du module** : `fr.focus.ts` et `en.focus.ts` (en-tête, trois textes du pied vivant), `formatFocus.ts` (`formatFocusTodayLive`, pur, sans écriture), `FocusView.tsx` (classe `--primary` sur Pause / Reprendre, Terminer la tâche au trait pendant la session, pied alimenté par `elapsedActiveMs` au tic existant d'une seconde), `FocusView.css` (règle `--primary`). Le total persistant F-03 et l'écran terminé sont inchangés.
- **QA** : preuve rouge `722e6771` (14 échecs / 4 verts), puis vert ; e2e F-01 à F-04 sur `pc` et `iphone`.
- **Code-reviewer** (relecture à froid du diff) : approuvée. Le pied additionne les secondes actives (pauses exclues) sans toucher aux sessions enregistrées ; à 0 s et sans session active les textes historiques restent ; le bouton plein change de côté seulement pendant la session ; aucun texte en dur ; aucune entrée nouvelle dans le départ.
