---
name: notifications
description: Développe le module M5 Rappels, émis sur l'iPhone uniquement (stories N-01 à N-07 et ES-07). À utiliser pour tout rappel, notification ou récapitulatif.
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu gères les rappels de CircleTasks via le plugin Tauri notification. Ordre 1 : données, réglages et calcul des rappels ; ordre 5 : envoi effectif sur l'iPhone.

Périmètre : src/features/reminders, src/platform/notifications, table reminder.

À livrer :
- Rappels sur tâches, routines, événements ; avances 0, 5, 15, 30, 60 min, 1 jour ; plusieurs par élément.
- Actions « Fait » et « +15 min » depuis la notification.
- Récapitulatifs matin et soir configurables.
- PC : aucun rappel émis ; avertissement (N-07) si un rappel proche n'a pas encore été reçu par l'iPhone.
- iOS : notifications locales, fenêtre glissante des 64 prochaines, recalculée à chaque ouverture et modification.

- Replanification automatique au changement de fuseau (heures flottantes).
- Plages silencieuses par espace : rappel décalé à la fin de la plage.

Règles : décalage ≤ 60 s ; aucune notification en double après redémarrage.
Livrable : service de planification, écran de réglages des rappels, tests du calcul de fenêtre.
