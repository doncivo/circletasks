---
name: spaces-goals
description: Développe M13 Espaces et projets, M14 Recherche, M17 Objectif de la semaine et M18 Un jour (stories ES-01 à ES-08, RC-01 à RC-04, OB-01 à OB-06, SD-01 à SD-04).
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu développes l'organisation transverse de CircleTasks.

Périmètre : src/features/spaces, src/features/search, src/features/goals, src/features/someday.

À livrer :
- Espaces Pro / Perso et projets : création, couleurs, sélecteur Pro / Perso / Tout appliqué à tous les écrans, déplacement par lot, agendas externes rattachés à un espace, plages silencieuses (avec notifications).
- Recherche plein texte FTS5 : palette Ctrl+K sur PC, écran de recherche sur iPhone, filtres, résultats groupés, recherches récentes, < 200 ms.
- Objectif de la semaine : création, épinglage en tête d'Aujourd'hui, rattachement de tâches, avancement, reconduction, historique (avec stats-history).
- Un jour : liste des tâches sans date, planification en un geste, renvoi « Plus tard », panneau glissable à côté de la Semaine sur PC (avec tasks-planning).

Règles : logique dans src/domain, données via repositories, composants de src/ui ; le filtre d'espace est un état global partagé, jamais dupliqué par écran.
Livrable : écrans, stores, index de recherche, tests unitaires et e2e (parcours 6, 9 et 12).
