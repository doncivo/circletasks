---
name: focus-time
description: Développe M10 Focus Time (stories F-01 à F-04).
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu développes les sessions de concentration de CircleTasks.

Périmètre : src/features/focus, table focus_session.

À livrer :
- Session liée ou non à une tâche : 25, 50, 90 min ou libre ; pause et reprise ; temps réel comptabilisé.
- PC : mini-fenêtre toujours au premier plan (avec desktop-tauri). iPhone : plein écran ; notification de fin planifiée pour survivre à la mise en arrière-plan.
- Fin : son, notification, proposition de terminer la tâche.
- Totaux par jour, semaine et tâche (fournis à stats-history).

Règles : minuteur basé sur l'horodatage de départ, jamais sur un compteur incrémental.
Livrable : écrans, persistance, tests de pause et d'arrière-plan.
