# N-IOS-FIX-01 — Rappel sur écran verrouillé : texte de remplacement et explication

## Validation sur le main B5 — 2026-10-21

**Statut : code validé localement, CI complète et compilation Swift attendues avant clôture ; essai appareil ouvert.** Branche existante `n-ios-apercus` conservée, remise sur main **1eac03fd** après #72 et le complément TLS #73. Aucun conflit de production ; conflits documentaires antérieurs résolus en gardant les deux historiques.

Preuve rouge courante **05e70a80**, correctif **8b25ac25**. Blobs du test et de l'adaptateur rouge identiques aux preuves exécutées avant rebase (`834aafed504840fe89cc1161ef580eb7838eca7c`, `e8d166d6dad0b37c8dc3f2b4a3a868049d7111c3`) ; adaptateur corrigé `f8d65d39f88ea88074ac3856294c8db54e693327`. Le rouge reconstruit explicitement l'ancien adaptateur pour prouver le champ perdu, sans prétendre découvrir une nouvelle régression de main.

QA après rebase : **345 tests / 24 fichiers** rappels et adaptateurs, couverture coupée, lint global et typage verts. Les sources applicatives et tests de ce module sont identiques après la dernière remise sur main ; les preuves précédentes 19 tests de frontière et 9 contrôles Rust restent consignées. La CI complète vérifiera à nouveau ces contrôles sur la tête publiée. Aucun délai ou timeout augmenté, aucun test désactivé ni retry automatique.

Passe code-reviewer distincte : diff depuis **1eac03fd** relu à froid, **approuvé côté code**. Champ facultatif dans TS et Codable, appel historique sans champ conservé ; identifiants/actions inchangés, titres utilisateurs et `%` absents des textes de catégorie ; aide simple iPhone seulement. Catalogues propres hors départ, garde du bundle sans nouvelle entrée autorisée. Compilation Swift et apparence réelle sur écran verrouillé réservées à l'unique lot iPhone. Mesure finale et CI encore requises avant fusion.

Module : M5 Notifications · Correctif rattaché à **N-01** et **N-03** (ADR 0012) · Agents : notifications (TS, plugin Swift `notification-actions`), qa-test, code-reviewer · Statut : code en validation (2026-10-20, branche existante n-ios-apercus), compilation et essai appareil ouverts.
Pas de nouvelle user story du PRD. Aucune commande ni permission nouvelle.

## Contexte

Séance iPhone 0.3.2 (2026-10-16) : le rappel d'une tâche est arrivé à l'heure sur l'écran verrouillé, mais la bannière affichait « CircleTasks — Notification » au lieu du titre et de l'heure. Le moteur envoie bien `title` et `body` (`tauriNotifications.ts`, `bridge.show`). Cause : le **masquage des aperçus d'iOS** (Réglages iOS > Notifications > Afficher les aperçus = « Si déverrouillé », valeur par défaut) ; iOS remplace le contenu par le nom de l'app et le texte de remplacement de la catégorie, « Notification » par défaut. Ce n'est pas un défaut du moteur.

## Critères testables

1. Chaque catégorie enregistrée (`ct.task`, `ct.routine`, `ct.event`) porte un `hiddenPreviewsBodyPlaceholder` tiré de `src/i18n` (fr et en), par exemple « Rappel CircleTasks : déverrouillez pour voir la tâche ». Le texte ne contient jamais le titre d'un élément ni le caractère `%`.
2. Côté Swift, le champ est facultatif (`String?`) : présent, `UNNotificationCategory(identifier:actions:intentIdentifiers:hiddenPreviewsBodyPlaceholder:options:)` (iOS 11) ; absent, comportement précédent. Un fichier de catégories sauvegardé par une version antérieure se décode toujours.
3. Réglages > Rappels, sur l'iPhone seulement : ligne d'aide en texte simple (ni alerte, ni lien, aucune ouverture des réglages iOS) qui explique le masquage et le réglage « Afficher les aperçus › Toujours ». Absente sur PC.
4. Tests : Vitest (spécifications de catégories, écran iPhone/PC), test statique Rust du contrat TS/Swift. Compilation Swift validée par `build-ios.yml`.

## Décision

Le texte de remplacement est une information de catégorie (iOS ne le lit que là) ; il ne peut donc pas contenir le titre. Le réglage d'aperçus appartient à l'utilisateur : l'app l'explique, ne le contourne pas. Les récapitulatifs et la fin de Focus n'ont pas de catégorie (aucune action) : ils gardent le texte iOS par défaut ; leur donner une catégorie changerait l'empreinte de leurs demandes, hors du périmètre de ce correctif.

## Passes de reprise et preuves

Clôture code du 2026-10-21 : PR #74 fusionnée dans main **454778a9**, tête **ad28cd48**, **48 contrôles CI verts** (39559200571 / 39559206397), couverture active et revue consignée. Branche distante historique rattachée après vérification d'équivalence de son patch ; aucun force-push, arbre testé inchangé. Bundle sur main **58/58, 338 479 normalisés, 338 411 bruts, marge 19 921**. Compilation Swift et rendu physique restent ouverts jusqu'au lot iPhone.

QA locale du 2026-10-20 : **48 tests ciblés**, puis **344 tests / 24 fichiers rappels et adaptateurs**, couverture coupée ; **9 contrôles Rust du contrat notification_actions**, lint global et typage verts. Le test de frontière JS → natif est rouge sur `1ed328c3` (adaptateur d'avant la story, texte absent), puis **19/19 verts** après rétablissement du champ facultatif, dont l'ancien appel sans champ. Lint du nouveau test vert. Le commit rouge reconstruit explicitement l'adaptateur de main pour isoler la perte de champ ; il ne constate pas une nouvelle régression de main.

Les trois textes de catégorie et la ligne d'aide sont isolés dans `notificationPreviewsText` et ses catalogues fr/en, chargés avec les modules de notifications et de réglages, gardés hors du départ. Aucun titre utilisateur dans les textes de remplacement, aucun `%`, aucun changement de catégorie des récapitulatifs ou de fin de Focus. Revue distincte, bundle, CI complète et compilation Swift encore requis ; le résultat visuel réel sur l'écran verrouillé reste ouvert jusqu'à l'IPA.

Reprise Codex du 2026-10-20 sur la branche existante, rebasée sur `ea596996` : commit historique `df8ab316` devenu `11ec2744`, seul conflit de journal conservé avec les preuves de main. Passe product-owner : quatre critères conservés ; textes nouveaux dans un catalogue propre chargé avec les modules de rappels et de réglages, garde hors du départ, aucun ajout à la liste de départ. Estimation d'intégration et vérification : 2 h actives, alerte à 3 h ; validation physique des aperçus réservée à l'unique lot iPhone. Fusion après Y-IOS-06, suite complète avec couverture en CI et revue distincte requises.

Passe code-reviewer distincte après QA, diff de `ea596996` à `e3cbfa4c` relu à froid : **approuvée côté code**. Champ facultatif à la frontière JS/natif et dans Codable, repli historique conservé ; actions et identifiants inchangés ; textes sans titre ni `%`, aide simple iPhone seulement, catalogues nouveaux isolés avec garde de départ. La preuve rouge reconstruit l'ancien adaptateur et la preuve verte du correctif `e3cbfa4c` couvre les 19 tests de cette frontière. Suite complète avec couverture, mesure finale sur le main après Y-IOS-06, compilation Swift et essai appareil encore ouverts.

Mesure préparatoire avant remise sur le main final : **58/58, 338 464 octets normalisés, 338 401 bruts, marge 19 936**, coût de départ **21 octets** depuis `ea596996`, aucune entrée ajoutée à la liste. Le premier essai de build avait échoué sur l'absence locale de `tesseract.js/dist/worker.min.js` : dépendances du worktree ancien incomplètes, complétées depuis le cache vérifié du dépôt ; aucun seuil ni test modifié. Nouvelle mesure exigée après rebase sur Y-IOS-06 et avant push.
