# N-IOS-FIX-01 — Rappel sur écran verrouillé : texte de remplacement et explication

Module : M5 Notifications · Correctif rattaché à **N-01** et **N-03** (ADR 0012) · Agents : notifications (TS, plugin Swift `notification-actions`), qa-test, code-reviewer · Statut : à relire (2026-10-16, branche n-ios-apercus)
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
