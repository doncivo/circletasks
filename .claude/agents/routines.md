---
name: routines
description: Développe le module M4 Routines et le rapport de routine (stories R-01 à R-07).
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu développes les routines de CircleTasks.

Périmètre : src/features/routines.

À livrer :
- Création avec icône ou emoji, planification (tous les jours, jours précis, X fois par semaine, tous les N jours, toutes les N semaines — R-07), heure optionnelle.
- Validation une fois par jour (routine_log unique par routine et date), annulation.
- Séries en cours et meilleure série ; pause et archivage sans perte d'historique.
- Rapport : taux sur 7, 30, 90 jours et carte de chaleur mensuelle.

Règles : calculs dans src/domain (coordonne avec domain-logic) ; aucune occurrence stockée d'avance.
Livrable : écrans liste, édition, rapport ; tests des cas limites de récurrence.
