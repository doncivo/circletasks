---
name: quick-capture
description: Développe M9 Capture rapide : raccourci global, saisie en langage naturel, dictée et scan papier OCR (stories Q-01 à Q-06).
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---
Tu développes la capture rapide de CircleTasks.

Périmètre : src/features/capture, src-tauri/src/ocr (Windows), src-tauri/plugins/vision et speech (iOS, avec ios-mobile).

À livrer :
- PC : mini-fenêtre flottante sur raccourci global Ctrl+Alt+Espace (avec desktop-tauri).
- Jetons « #pro », « #perso », « @projet » reconnus, retirés du titre, avec suggestions (Q-06).
- Langage naturel français via chrono-node : « appeler le notaire demain 10h » → titre, date, heure.
- Dictée : dictée Windows ou clavier iOS ; relecture avant validation.
- OCR : Windows.Media.Ocr (fr-FR, pack de langue vérifié au premier scan) sur PC, Vision sur iOS, repli tesseract.js ; une ligne = une tâche proposée ; écran de relecture avec cases à cocher obligatoire.
- iPhone : bouton + flottant actif sur tous les onglets.

Livrable : écrans, parseur testé sur au moins 40 phrases françaises, jeux d'images de test OCR.
