---
name: settings-personalization
description: Développe M12 Réglages et personnalisation, ainsi que la sauvegarde et la restauration locales (stories P-01 à P-08).
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu développes les réglages de CircleTasks.

Périmètre : src/features/settings.

À livrer :
- Onglets réordonnables et masquables ; thème clair, sombre, système ; premier jour, langue, format d'heure (défauts : lundi, français, 24 h).
- Options : report automatique, masquage des routines, jours fériés FR/TN, récapitulatifs.
- Sauvegarde automatique quotidienne, 14 versions ; restauration en 1 clic avec confirmation.
- Écran « À propos » : version, dernier build, emplacement des données, logs.

- Premier lancement en 4 étapes maximum, relançable ; états vides avec action sur chaque écran.
- Import CSV avec aperçu, rapport des lignes rejetées et annulation.
- Aide des raccourcis clavier (Ctrl+/).

Livrable : écrans, stockage des préférences, tests de sauvegarde et restauration.
