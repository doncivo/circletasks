# UI-FIX-02 — Paquet A, défauts constatés sur iPhone 1.0.0

## Paquet A — publication vérifiée du 24 octobre 2026

PC et iPhone **1.0.1** publiés depuis **b8ddc85f**, tags v1.0.1 / ios-v1.0.1 ; runs **40090523636 / 40090523848** verts. IPA : 7 356 612 octets, SHA-256 d1ba316c179036369a656ef718591ed3f8e2ba4dc5c332710d2bd80988244e97, asset/artefact/source SideStore concordants, Info.plist et contrat cinq plugins valides. Signature PC Ed25519 et endpoint updater 1.0.1 vérifiés sans exécuter l'EXE. Mise à jour PC exclusivement par bannière, puis iPhone SideStore sans désinstallation. Guide : docs/essais-iphone.md.

Bundle main après #83 : **58/58, 339 198 normalisés, 339 190 bruts, marge 19 202 octets**, plafond et liste de modules inchangés ; +722 octets pour le paquet. CI applicative 48/48, lint, typage et revue approuvée. **Vérification native du paquet et clôture REL-01 à REL-03 encore ouvertes** ; ne pas écrire « fait ». A9 reste le trou assumé décidé par Ali, A6b « vérifié en usage après la 1.0 » est futur, pas exécuté. Suivi documentaire sur rel-03-paquet-a-1-0-1 ; aucune recompilation pour ces textes.

Statut : code fusionné par #83 dans b8ddc85f après 48 CI verts de 80970c6c ; vérification sur appareil encore ouverte. Estimation initiale : 6 à 8 h actives ; alerte à 12 h. Une branche et une PR pour le paquet ; une compilation iPhone pour le lot terminé.

## Passe product-owner — 24 octobre 2026

Ordre imposé par Ali : (1) couleurs des états de synchronisation, (2) zones sûres de tous les écrans, (3) lecture jamais effectuée, (4) double « le », (5) gabarit des appareils, (6) noms lisibles et modifiables, identifiant secondaire, (7) rattachement sans objectif et chevauchement, (8) commande de fin unique, (9) expiration de signature remontée, (10) noms lisibles des champs de conflit.

Nouvelle tâche et Détail : corriger seulement ces défauts, pas de refonte avant les maquettes d'Ali. Noms d'appareils : préférer une préférence locale persistante sans migration ni modification du protocole de synchronisation. Ne jamais prétendre qu'un surnom local est partagé entre appareils. A9 reste le trou assumé décidé le 21 octobre ; aucun banc à reprendre.

## Preuves et validations

À consigner par point : preuve rouge avant modification, preuve verte après, limites natives. Lint, typage, revue à froid et CI complète avec couverture obligatoires. Bundle avant push et sur main après fusion ; plafond inchangé. Aucun point « fait » sans ces preuves.

### Passe agent du module et QA locale

- 1 : rouge 32d3b748 ; correction b2ca3887, 47 tests ciblés verts. Complément de couleur calculée e0006982 : « Dossier choisi » ne prouve pas un envoi, neutralisé ; 13 contrôles de géométrie et de couleurs verts.
- 2 : rouge eb1461b3 puis extension 321dca2f ; correction 4d783a88. Onze conteneurs contrôlés : coquille, feuilles, association, scan, verrouillage, confirmation, choix, date, sauvegardes, export et accueil. Les boîtes conservent leur largeur prévue ; les marges sûres bornent leur défilement.
- 3 et 4 : rouge 321dca2f, correction 4d783a88 ; 6 tests verts. Un HLC d'instant zéro n'est plus une heure de lecture/publication ; les vraies heures de minuit restent valides. Création : une seule préposition pour aujourd'hui, hier et une date passée.
- 5 : rouge f5178fa7, correction add83332 ; 52 tests verts. Identité et lecture regroupées, même gabarit et colonne de statut, y compris pour cet appareil.
- 6 : rouge 635e0df6, correction 5f0ee82a ; 19 tests verts, puis couverture des écrans affectés. Noms par défaut numérotés lisibles ; surnoms locaux persistés dans `sync_meta.ui.deviceNames`, pas dans les journaux partagés. Identifiant complet secondaire ; échec d'enregistrement visible sans faux succès.
- 7 à 10 : preuves rouges 5e6fbfa5 (dont un ancien attendu de date devenu obsolète, non compté comme défaut nouveau) et db9f4657 pour la destination du bandeau d'expiration. Correction locale : un seul texte sans objectif, choix périmé désactivé au changement de semaine, icône iPhone décorative et modifiable par Modifier, expiration avant Général et renvoi cohérent, noms de champs « date prévue », « heure prévue », « état de la tâche ». « TEST » reste le titre de la tâche, jamais réécrit.
- QA complémentaire : 171 tests verts sur dix fichiers, puis 94 sur cinq fichiers après adaptation du test d'oubli (l'appareil oublié reste renommable mais pas oubliable de nouveau). Parcours de modification/retrait d'icône : PC et iPhone, 2/2 verts, aucun parcours supprimé. Tests ciblés avec couverture coupée ; validation complète en CI requise.

Le premier lancement local forks a échoué avant tout test (démarrage du worker), jamais compté comme rouge fonctionnel. IPC et construction jsdom natifs vérifiés ; tests exécutés ensuite en threads sans changer les délais. Configuration CI inchangée. Lint a relevé quatre assertions de non-nullité interdites dans les nouveaux tests : remplacées par des gardes, attentes conservées.

Version de lot préparée : 1.0.1 sur PC et iPhone, registre SQL toujours 19. Publication et vérification des artefacts uniquement après revue et CI verte ; pas de nouvelle compilation pour une simple correction documentaire. Vérification physique des dix points à faire par Ali.

### Passe code-reviewer distincte

Diff relu à froid depuis a8d0282b : le vert est opt-in et ne dépend pas seulement de l'absence d'erreur ; aucun accusé HLC zéro n'est présenté comme une lecture, sans masquer une vraie modification à minuit. Les zones sûres bornent le conteneur qui défile, y compris le bas et le paysage (complément rouge b69c131a, 14 contrôles verts après correction). Les noms restent des préférences locales, aucune écriture dans le protocole ou les clés ; lecture illisible bloquante pour le renommage, erreur visible et reprise sans écrasement (4 tests verts). Les statuts gardent leur colonne malgré l'ordre de chargement des styles. Commande d'icône conservée par Modifier sur iPhone ; PC inchangé. Renvoi du bandeau d'expiration adapté à la nouvelle place. Pas de refonte des deux fiches en attente de maquettes.

Revue du code approuvée, sous réserve de la CI complète avant fusion. Lint global et typage verts après correction d'une clé i18n manquante et d'une propriété optionnelle explicitement mise à undefined (option TypeScript stricte conservée). Dernière vérification de lecture : 20 tests verts, dont minuit réel et « Jamais lu ». Bundle final en cours avant push ; aucun relèvement de plafond, aucune entrée de module ajoutée à la liste autorisée. La preuve native reste ouverte, distincte de cette approbation de code.

### Première CI et correction des références partagées

PR #83, tête 5064a048 : les runs 40088084837 / 40088088787 accusent les anciens noms courts dans les tests de conflits/sauvegardes, l'origine inconnue d'une sauvegarde devenue trop générique, et deux attentes de parcours (champ « heure » et absence de tout bouton sur appareil oublié). Correction : origine inconnue des sauvegardes toujours accompagnée de son identifiant de secours, appareils connus numérotés lisiblement, assertions de restauration et de renommage alignées avec le comportement demandé. L'appareil oublié garde Renommer, mais pas Oublier ; les vérifications de suppression, de restauration, de focus et de convergence sont conservées. Aucune attente, aucun timeout ni seuil modifié.

QA de cette correction : 37 tests verts sur les trois fichiers accusés, les deux scénarios d'oubli verts et J10 composé PC/iPhone (conflit/restauration/convergence) vert. Relecture du petit diff approuvée. Première mesure du paquet : 58 contrôles bundle verts, 339 198 octets normalisés, 339 199 bruts, marge 19 202 ; coût 722 octets depuis main. Nouvelle mesure obligatoire avant le prochain push et nouvelle CI complète sur la tête corrigée ; ne pas fusionner grâce aux succès partiels de la première tête.
