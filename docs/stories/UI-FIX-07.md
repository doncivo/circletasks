# UI-FIX-07 — Semaine iPhone : la marque d'objectif revient sur la ligne (PRD-02, lot C, réserve d'Ali)

Module : M3 Semaine, avec M17 Objectif (OB-03 critère 3) · Palier : alignement PRD-02 décidé par Ali le 2026-10-28, à livrer dans l'IPA N+1 · Agent : tasks-planning · Ouverte le 2026-10-28 par Claude Code.

Statut : **en CI, passes product-owner, module et revue écrites.** Estimation : 1 h active ; alerte à 2 h.

## Origine

UI-REFONTE-03 (Semaine-v2.html) avait retiré de la ligne iPhone la marque « objectif » (cible colorée, libellé accessible « Rattachée à l’objectif »), écart OB-03 critère 3 consigné dans la fiche et soumis dans PRD-02 (lot C). Décision d'Ali : « La marque d'objectif dans la Semaine est de l'information, pas de la décoration — c'est la seule chose qui me dit d'un coup d'œil quelles tâches servent mon objectif. Garde-la. Ma maquette l'avait perdue à tort. » Le PRD (OB-03 critère 3) reste donc la règle ; la ligne iPhone de l'agenda d'Aujourd'hui n'est pas concernée (lot C accepté pour T-03 et OB-02).

## Critères

1. Sur iPhone, une tâche rattachée à l'objectif de la semaine porte, dans sa ligne de la Semaine, la marque `TaskGoalMark` (cible, couleur `--ct-color-goal`, `role="img"`, libellé « Rattachée à l’objectif ») après le titre ; une tâche non rattachée n'en porte pas.
2. La ligne garde sa forme de UI-REFONTE-03 (heure en colonne, case, titre, « en retard » le cas échéant) ; rien d'autre ne revient (pas d'icône décorative, T-03 accepté).
3. PC inchangé (la carte porte déjà la marque, OB-03 critère 3).
4. Bundle de départ : la Semaine est à la demande ; `TaskGoalMark` est déjà dans le départ (ligne d'Aujourd'hui PC) ; mesure attendue à ± 0.
5. Fiche UI-REFONTE-03 : la ligne OB-03 du tableau des écarts renvoie à cette décision.

## Preuves attendues

- **Rouge d'abord** : `src/features/goals/GoalAttach.test.tsx`, test de la Semaine iPhone inversé (la marque est attendue), rouge sur `main`.
- **Vert ensuite** : suites `goals`, `week` ; lint ; typage ; garde du bundle ; CI complète.

## Hors périmètre

L'agenda d'Aujourd'hui (iPhone et PC) ; l'icône de tâche ; le PRD (PRD-02 est la mise à jour documentaire, séparée).

## Passe agent du module

- **Preuve rouge** : commit 73e1443a (test seul) : `src/features/goals/GoalAttach.test.tsx`, test de la Semaine iPhone inversé (la marque est attendue), rouge sur `main`.
- **Vert ensuite** : commit a85f3c53 : `WeekItems.tsx`, ligne iPhone : `{task.goalId && <TaskGoalMark size={14} />}` après le titre, avant « en retard » ; `TaskGoalMark` importé de `taskLine` (composant déjà dans le départ). Rien d'autre ne change : heure en colonne, case, titre, PC intact.
- **Fiche UI-REFONTE-03** : la ligne OB-03 du tableau des écarts renvoie à cette décision.
- **Local** : suites `goals` et `week` (230 tests) vertes ; lint ; typage.

## Mesure du bundle

Avant push (commit a85f3c53, build `--manifest`, `node tests/bundle/measureStart.ts`) : **337 901 octets normalisés** (brute 337 754, écart +147 dans la borne large de 300), **marge 20 499** ; **+6** face à `main` 337 895 ; garde 66/66, aucun module nouveau. Mesure de `main` après fusion : à consigner.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

Relecture à froid du diff : une ligne de rendu et un import. Vérifié : la marque n'apparaît que si `task.goalId` est défini (même garde que la carte PC et que l'ancienne ligne d'avant UI-REFONTE-03) ; le libellé accessible « Rattachée à l’objectif » est celui du PRD ; la taille 14 px s'aligne sur la hauteur de ligne iPhone ; la Semaine reste à la demande, `TaskGoalMark` était déjà dans le départ. Point laissé à la QA : voir sur l'appareil que la marque ne pousse pas un long titre à la ligne (la ligne est `flex`, le titre `min-width: 0`).

Verdict : approuvée sous réserve de la CI complète (QA à consigner).
