# ADR 0005 — Horodatage de synchro (HLC) et actions annulables

- Statut : accepté
- Date : 2026-10-02
- Tâche : T-01 (étape architecte) ; prépare T-04, T-05, T-08, T-12, T-13 et M15 (ordre 4)

## Contexte

La synchro (ordre 4) fusionne champ par champ selon l'horloge logique hybride la plus élevée (PRD 6 et 7). Si les lignes écrites dès l'ordre 1 n'ont pas un `hlc` correct et monotone, toute la base existante sera mal fusionnée plus tard. Par ailleurs T-13 impose une annulation uniforme (message 5 s, Ctrl+Z, 20 actions) que T-04, T-05, T-08 et T-12 doivent partager.

## Décision

### Horodatage de chaque écriture

- Chaque ligne insérée ou modifiée par un repository reçoit un `WriteStamp` (`src/domain/hlc.ts`) : `created_at = at` (insertion seulement), `updated_at = at`, `device_id`, `hlc`. Une suppression logique est une écriture (`deleted_at = at`, nouveau hlc), une restauration aussi.
- Le `WriteStamper` est injecté dans la `RepositoryFactory` ; les repositories ne lisent jamais l'horloge.
- Les écritures venues de la synchro (ordre 4) ne passent pas par le `WriteStamper` : elles gardent le hlc distant et appellent `HlcClock.receive()`.

### Format et générateur HLC

- Texte `<ms : 15 chiffres>-<compteur : 4 hexa>-<device_id>`, largeurs fixes : l'ordre des chaînes est l'ordre de fusion ; l'UUID départage les égalités.
- `createHlcClock({ clock, deviceId, seed })` : algorithme HLC standard (`now`, `receive`) ; débordement du compteur (65 535) → +1 ms. Implémentation complète dès maintenant, testée.
- Monotonie après redémarrage : `seed` = `SyncMetaRepository.maxHlc()` (plus grand hlc en base, lignes supprimées comprises), lu par `bootstrapApp`.
- Identité de l'appareil : UUID créé au premier lancement, réglage local `device.id`. Aucune limite de dérive n'est appliquée à l'ordre 1 ; sync-icloud décidera (ordre 4) du traitement d'un hlc distant trop en avance.

### Actions annulables (`src/features/app/undo.ts`)

- `UndoableCommand { kind, count, undo(): Promise<'undone' | 'stale'> }` ; `UndoStack` par conteneur (20 commandes, mémoire de session), `undoLast()` sérialisé, `subscribe` / `getSnapshot` compatibles `useSyncExternalStore`, `pushCount` pour relancer le minuteur du message.
- Le cas d'usage pousse lui-même sa commande après l'écriture. La commande garde l'état d'avant et le hlc écrit ; à l'annulation, si le hlc courant de la ligne diffère (autre action, synchro), elle renvoie 'stale' sans rien écrire.
- Annuler = nouvelle écriture avec nouveau hlc (jamais de retour en arrière de l'historique) : la synchro la traite comme une modification ordinaire.
- Message « Annuler » : `UNDO_TOAST_MS` (5 s) sur `snapshot.top`, libellé `UNDO_LABEL_KEYS[kind]` ; Ctrl+Z (`app.undo`) appelle `undoLast()` même après la disparition du message ; hors champ de saisie seulement.
- Une commande dont l'annulation échoue est retirée de la pile (pas de boucle), l'erreur est remontée à l'appelant.

## Conséquences

- data-model : chaque table synchronisée a `id`, `created_at`, `updated_at`, `deleted_at`, `device_id`, `hlc` NOT NULL (sauf `deleted_at`) et un index utile à `maxHlc()`.
- Les tests de repositories vérifient qu'une écriture change `updated_at` et augmente `hlc`.
- La pile d'annulation est perdue à la fermeture : conforme à T-13 (« dans la session »).
