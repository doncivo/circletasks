# B5 — inventaire des effacements d'erreurs persistées

## Reprise du 2026-10-21 — décision et périmètre prouvé

Ali approuve **5 h** : périmètre réel, pas une dérive. Il exige un rouge propre à chaque chemin corrigé ; un suspect non prouvé est conservé pour après la 1.0. `86eeadc0` a été poussé sur `origin/y-ios-02-fix-01-partiel` après bundle **58/58** et contrôle des secrets **0 candidat**.

Preuves avant correctif : **`9dba2a9e`**, avec les rouges antérieurs `016dbd04` et `86eeadc0`. L'essai initial de l'oubli a capturé sa cause trop tard (la façade lance deux cycles) ; corrigé avant toute modification fonctionnelle pour garder les refus jusqu'à la bascule explicite vers `complete: false`. Les deux réparations Apple sont testées séparément. Aucun délai, timeout allongé, relance automatique ou test désactivé.

- **Entretien orphelin** : `ownDeletionPersistence.test.ts`, compteur 1 pour une époque listant deux instantanés ; intention et cause effacées à tort. Correctif : le scan suivant confirme l'absence avant de retirer l'intention.
- **Oubli partiel** : `forgetQa.test.ts`, refus durable, puis `deleted: 1, complete: false` ; cause effacée à tort. Correctif limité à la garde `complete` pour cette cible et cette étape.
- **Reprise par tranches** : `pairing/join.test.ts`, interruption puis lectures de la base pendant la reprise ; cause effacée avant la transaction finale. Correctif : conserver la cause à l'ouverture et dans chaque transaction de tranche ; effacement final conservé.
- **Rappels Apple** : `appleFailureKinds.test.ts`, passage complet interrompu par son échéance ; `appleListsSafety.test.ts`, réparation et détachement de listes après erreur du magasin. Correctif : passage partiel conserve la cause, réparation n'efface que `lists-setting-invalid`, dans la mise à jour sérialisée.
- **B5 initial et lot partiel** : `mixedOldEpochDeletion.test.ts` et `ownDeletionPersistence.test.ts`. Correctif : compteur global insuffisant pour effacer les causes d'une époque ou d'un lot incomplet ; absence confirmée ou suppression complète d'un lot de fichiers individuels résout la cause. Heure et code antérieurs conservés dans le cas partiel, y compris au redémarrage.

QA ciblée après correctif : **49/49**, couverture coupée. QA élargie, lint, typage, revue distincte et CI complète restent à consigner avant fusion ; ce point ne déclare pas la story terminée.

### Suspects non prouvés — après la 1.0, aucun changement de code

- `abandonOrphan/state-mismatch` : le test historique exige l'annulation de l'entretien ; pas de scénario indépendant prouvant que la cible reste effectivement supprimable après ce refus. Bloqueur : distinguer annulation légitime et échec encore actif sans inventer un état impossible de la plateforme.
- `joinFromSnapshot`, branches sans candidat/sans application : la lecture des journaux peut remplacer la reprise d'instantané. Bloqueur : pas de preuve d'une opération restant réellement en échec après cette alternative. Seules les tranches du scénario rouge sont modifiées.
- `requestAccess` Apple : pas de preuve isolant une erreur encore active de la réussite du passage complet lancé ensuite par le coordinateur. Bloqueur : établir cette frontière sans accuser le succès de la reprise ; le chemin n'est pas modifié.
- Écritures Apple retenues ou sender absent : le seul rouge ici concerne la lecture interrompue, pas ces cas. Bloqueur : distinguer retenue volontaire, absence de travail et véritable opération échouée encore due ; aucun changement dédié.
- Focus : absence de preuve d'effacement d'une erreur d'une session encore active par une autre session. Bloqueur : fermeture et annulation résolvent volontairement la notification de la session close selon F-04 critère 15 ; ne pas modifier cette décision sans scénario accusateur.
- Réinitialisation, réassociation, modes d'association et signature sans autorisation : lecture seule ; aucun rouge dédié ni correction. Bloqueur : établir des erreurs de la même opération encore actives, et non des contextes remplacés/résolus. Les acquittements explicites restent également inchangés.

L'inventaire historique ci-dessous garde les hypothèses initiales ; ce point prévaut sur ses injonctions de correction et sur l'ancien arrêt d'estimation.

Recensement statique avant correction, demandé par Ali le 2026-10-20. Périmètre : code de production TypeScript, Rust et plugins Swift ; rechercher aussi les remplacements d'état et suppressions de clés, pas seulement `failure: null`. Les états React/Zustand non persistés, doubles mémoire et initialisations sans erreur antérieure ne sont pas des effacements persistés. Aucun correctif fonctionnel appliqué à ce stade.

## Effacements prématurés à corriger ensemble

- `src/sync/ownDeletion.ts`, `deleteOwnTracked` : un compteur agrégé positif efface toutes les causes du lot, même pour une époque partiellement supprimée. **Prouvé rouge `016dbd04`** sur service complet ; second test explicite de persistance ajouté dans `ownDeletionPersistence.test.ts`, rouge également. `save` recopie ensuite cette perte dans `ownDeleteFailure` et `orphanDeleteFailure`.
- `src/sync/orphanEpoch.ts`, `retryOrphanDeletion` : le même compteur positif efface l'intention d'entretien sans prouver la disparition de toute l'époque. `abandonOrphan` efface aussi la cause sur un refus `state-mismatch`, qui n'est pas un succès de suppression. Chemins établis par lecture ; preuves rouges dédiées encore requises.
- `src/sync/forget.ts`, `runForgetDeletions` : efface la cause `delete` après `deleteFiles`, même lorsque `result.complete` est faux. Les chemins `done` sans fichiers stricts et absence au listing sont distincts. Preuve rouge dédiée encore requise, avec scan incomplet à contrôler.
- `src/sync/join.ts`, `resumeFromSnapshot` / `applyJoin` : remplace la cause par `null` avant application et à chaque tranche ; une tranche réussie ne prouve pas la réussite de la transaction finale. La branche sans candidat et la sortie sans application doivent également conserver la cause tant que la reprise reste demandée. Preuve rouge dédiée encore requise.
- `src/features/calendars/appleReminders/remindersPass.ts`, `failureAfter` : le booléen `full` suffit à effacer alors que `partial` peut être vrai ; le chemin d'écriture doit aussi tenir compte des envois restant dus et de l'absence de sender. Preuves rouges dédiées encore requises.
- `appleRemindersActions.ts`, `requestAccess` : une autorisation accordée efface toute cause, pas seulement `access-denied`. Comparer avec `refreshAccess`, déjà limité au code concerné. Preuve rouge dédiée encore requise.
- `appleListRepairs.ts`, `resetLists` et `detachUnlisted` : effacent toute cause après réparation des réglages. **Prouvé rouge** : `resetLists` efface `store-unavailable` sans aucune lecture du magasin réussie (`appleListsSafety.test.ts`). Le détachement doit viser sa propre cause uniquement.
- `src/features/focus/focusStore.ts` / `notificationStatus.ts` : effacement sans comparer `sessionId` ; `closed` efface avant même le résultat de l'annulation. À couvrir par une preuve rouge avant correction, notamment avec opérations concurrentes et redémarrage.

## Autres familles et conditions de résolution relues

- Suppressions propres : `observeOwnDeletions` exige une absence dans un scan complet ; garde déjà présente. `clearOrphanDeleteFailure` doit rester réservé à cette preuve, contrairement à son appel sur refus ci-dessus.
- Restauration : `src/sync/service.ts`, `chooseRestoreOption`, efface après application du choix et retrait réussi du marqueur ; l'option de reprise exige un résultat `done`. Le passage suivant n'efface pas directement cette clé. Contrôle complémentaire du sens de `done` avec attente partielle à conserver dans la QA.
- Publication : `src/sync/publisher.ts` et `orphanEpoch.ts` effacent `publishRotation` après preuve de tête publiée ou publication ; vérifier les changements d'époque et la borne `maxHlc` dans la QA. Aucun effacement inconditionnel de cette cause à chaque cycle.
- Réinitialisation : `src/sync/reset.ts`, `clearResetFailure` vise étape et code ; ouverture d'époque et republication effacent après leur opération. `evaluateReset` remplace aussi l'état selon les étapes, la nouvelle clé et le registre : les transitions de phase ne suffisent pas seules comme preuve ; cas de causes d'une autre étape à ajouter à la QA avant conclusion définitive.
- Oubli/réintégration : `forget.ts` borne l'effacement par appareil et étape ; le retour après réassociation doit être contrôlé pour les étapes `declare/delete` en plus de `rejoin`. `sql/syncUnknown.ts` supprime `reintegrationFailure` après un parcours complet sans ligne échouée, pas après le simple succès d'une ligne.
- Association : `features/sync/pairingStatus.ts` efface `pairingFailure` à l'ouverture ou à l'association. La distinction des modes `show/import` demande un contrôle de non-effacement croisé. `src-tauri/src/sync/service.rs`, `key_import`, retire `import-failure.json` après l'import réussi ; la lecture de statut ne le retire pas.
- Notifications : `replanNotifications.ts` réécrit `planFailure` après remplacement du plan, en conservant l'échec de signature ou de fuseau du passage ; `notificationActions.ts` efface après collecte/application sans erreur technique, les erreurs par action restent dans la file ; `signingNotice.ts` efface l'erreur persistée de lecture après lecture du profil réussie. Les erreurs de programmation de l'alerte de signature et les passages sans autorisation doivent faire partie de la QA de cette généralisation.
- Journaux : `platform/logs/buffer.ts` et Rust `applog.rs` gardent un état de processus, pas une erreur persistée restaurée. Lecture réussie limitée à `readError`, écriture réussie limitée à `writeError` ; `clear` concerne explicitement le journal supprimé.

## Acquittements explicites déjà spécifiés, à distinguer d'un cycle réussi

`forget.ts/cancelForgetRequest` annule une demande jamais déclarée (Y-10-FIX-01, critère 3) ; `reset.ts/dismissResetState` ferme un état ; `appleRemindersActions.ts/ignoreFailure` propose « Ignorer » ; `epochCarryReportBanner.ts/clearCarryReportFailure` propose « J'ai vu ». Ce sont des effacements délibérés, sans succès du travail initial. Ils sont consignés ici sans modifier leurs décisions d'interface pendant cet inventaire. La portée littérale de « seulement par un succès réel » sur ces acquittements reste à résoudre avant de prétendre que tous les effacements respectent cette règle.

## Preuves et estimation

Le complément B5 seul était estimé à **2 h actives**, seuil d'alerte **3 h**. Le recensement étend le correctif à plusieurs opérations et à leurs reprises : nouvelle estimation **5 h actives**, soit **+150 %**. **Arrêt au commit selon le cas 3 demandé par Ali**, avant correction ; ce n'est pas une clôture ni un feu vert de livraison. Les points signalés par lecture ne portent pas de preuve rouge inventée. Le périmètre reste rattaché à B5, sans nouvelle story.

#71 a été fusionnée en parallèle : main `dc14badf`, 48 contrôles verts, revue déjà consignée ; bundle **58/58**, mesure séparée **338 413 normalisés / 338 339 bruts**, marge **19 987**, plafond inchangé. Aucune nouvelle compilation iPhone.
