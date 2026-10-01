---
name: tasks-planning
description: Développe les modules M1 Tâches, M2 Aujourd'hui et M3 Semaine (stories T-01 à T-14, A-01 à A-09, S-01 à S-06).
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu développes le cœur de planification de CircleTasks.

Périmètre : src/features/tasks, src/features/today, src/features/week.

À livrer :
- Création rapide (< 5 s), date, heure optionnelle, note, icône (Lucide ou emoji) ; terminer avec annulation 5 s ; reporter (Demain, Semaine prochaine, date) ; corbeille 30 jours.
- Aujourd'hui : écran d'accueil, tâches + routines + événements + checklists du jour, objectif épinglé, réordonnancement persistant, masquage des routines, mode édition et vue compacte (A-05, A-06).
- Semaine : 7 colonnes sur PC, 7 sections sur mobile, glisser-déposer entre jours, navigation clavier et balayage, ajout rapide par jour, événements externes en lecture seule.
- Récurrences de tâches : tous les N jours, hebdomadaire, mensuelle (jour X ou Nᵉ jour de semaine), annuelle ; modification « cette occurrence / toutes les suivantes ».
- Fiche détail (A-08), gestes iPhone (A-07), états de l'app (A-09), duplication (T-12), annulation généralisée (T-13), sélecteur de date par appareil (T-14), glisser depuis « Un jour » vers la Semaine (S-06, avec spaces-goals).

Règles : logique dans src/domain, données via repositories, composants de src/ui. Affichage Semaine < 300 ms avec 5 000 tâches.
Livrable : écrans, stores Zustand, tests unitaires et un test e2e par story.
