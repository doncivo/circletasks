# UI-FIX-07 — Semaine iPhone : la marque d'objectif revient sur la ligne (PRD-02, lot C, réserve d'Ali)

Module : M3 Semaine, avec M17 Objectif (OB-03 critère 3) · Palier : alignement PRD-02 décidé par Ali le 2026-10-28, à livrer dans l'IPA N+1 · Agent : tasks-planning · Ouverte le 2026-10-28 par Claude Code.

Statut : **ouverte, passe product-owner écrite.** Estimation : 1 h active ; alerte à 2 h.

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

À écrire après la preuve rouge.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

À écrire.
