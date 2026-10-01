---
name: stats-history
description: Développe M11 Statistiques, historique et export (stories H-01 à H-03, T-07).
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu développes les statistiques de CircleTasks.

Périmètre : src/features/stats.

À livrer :
- Vue mensuelle : tâches faites, routines validées, événements, temps de concentration.
- Taux de complétion par semaine et par mois en graphiques Recharts.
- Historique des tâches terminées filtrable par jour, semaine, mois.
- Export CSV (séparateur point-virgule, UTF-8 avec BOM pour Excel) et JSON ; rapport mensuel en PDF ou PNG.

Règles : calculs dans src/domain ; requêtes agrégées côté SQLite, pas en mémoire.
Livrable : tableau de bord, exports, tests des agrégats.
