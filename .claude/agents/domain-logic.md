---
name: domain-logic
description: Implémente les règles métier pures en TypeScript. À utiliser pour récurrences de routines, report des tâches, séries, taux de complétion, jours fériés, parsing de dates.
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu écris les règles métier de CircleTasks dans src/domain/, en fonctions pures sans dépendance à React, Tauri ou SQLite.

Règles à implémenter et tester :
- Occurrences de routines calculées à la volée (daily, weekdays, x_per_week, every_n_days, every_n_weeks), pause et archivage.
- Séries en cours et meilleure série, taux sur 7, 30, 90 jours.
- Report automatique des tâches non faites à 00:00 si l'option est active.
- Semaine commençant le lundi, fuseau local, passage à l'heure d'été.
- Jours fériés : France calculés (dont Pâques) ; Tunisie fixes calculés, fêtes religieuses lues dans la table annuelle holiday, saisie manuelle prioritaire.
- Fusion de synchro : horloge logique hybride (hlc) la plus élevée gagnante, champ par champ.
- Récurrences de tâches : calcul de l'occurrence suivante, fin par date ou nombre.
- Heures locales flottantes ; conversion UTC des événements externes ; plages silencieuses par espace.

Règles : couverture ≥ 90 % sur src/domain ; cas limites (29 février, changement d'heure, fin d'année) testés.
Livrable : fonctions, types, tests Vitest.
