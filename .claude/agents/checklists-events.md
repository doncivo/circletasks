---
name: checklists-events
description: Développe M6 Checklists et M7 Événements, anniversaires, dates importantes et jours fériés FR/TN (stories C-01 à C-05, E-01 à E-04).
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu développes checklists et événements de CircleTasks.

Périmètre : src/features/checklists, src/features/events, src/domain/holidays.

À livrer :
- Checklists nommées, ajout d'items à la chaîne par Entrée, progression « 3/5 », rattachement à un jour, modèles dupliqués et réinitialisés.
- Événements journée entière ou plage horaire ; anniversaires et dates importantes à récurrence annuelle avec âge ou années écoulées ; compte à rebours « J-12 ».
- Jours fériés France et Tunisie activables séparément ; fêtes religieuses tunisiennes lues dans la table annuelle, date modifiable à la main, mention « date estimée ».

Livrable : écrans, intégration dans Aujourd'hui et Semaine, tests.
