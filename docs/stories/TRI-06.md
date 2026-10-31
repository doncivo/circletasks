# TRI-06 et TRI-04 — Deux pertes de synchro qui ne laissaient qu'une ligne de journal deviennent visibles

Module : M15 Synchronisation · Palier : avant la 1.0, **rendre l'échec visible seulement** (arbitrage d'Ali du 2026-10-30) · Agent : sync-icloud · Ouverte le 2026-10-30 par Claude Code. Tri : `docs/audits/2026-10-30-tri-importants.md`, lignes TRI-06 (4 h) et TRI-04 (2 h).

Statut : **code, tests, lint, typage, bundle verts en local ; revue consignée ci-dessous ; CI complète à attendre avant fusion.** Réel : environ 2 h 30 pour les deux.

## Origine

- **TRI-06** : une opération locale de plus de 256 Kio (typiquement une note) est refusée par `publish-too-large`, retirée de la file et **jamais publiée** ; seul le journal technique le disait. L'autre appareil ne la verra jamais.
- **TRI-04** : une opération reçue en attente de son parent (`missing-parent`) n'avait aucun signe visible, et son abandon au plafond de 10 000 (`cap-dropped`) non plus.

## Critères

1. TRI-06 : le refus compte dans `sync_meta.publishDropped` (`{ n, tables }`, jamais de contenu), écrit **avant** le retrait de la file ; l'avertissement `publish-dropped` est levé dans le cycle même, interdit « À jour », survit au redémarrage, texte fr/en dans la section AVERTISSEMENTS et le bandeau. Le cas n'est pas traité (aucun découpage).
2. TRI-04 : un `missing-parent` encore en attente après lecture complète lève `received-unapplied` (même texte, même acquittement que TRI-24) ; un abandon au plafond (`cap-dropped`, genre `parked`) est compté dans `applyRejected` et lève le même avertissement.
3. Effacement : « Lancer une reprise complète » efface les deux compteurs (acquittement). **Limite assumée** : pour TRI-06 cela acquitte, cela ne publie pas la note ; elle reste non publiée jusqu'à ce qu'on la réduise.
4. La reprise automatique reste réservée à `missing-row` (un parent absent n'est pas un enregistrement sauté : l'étendre rejouait des abandons, constaté par `wholeRowDuringPublish`).
5. Aucun changement de schéma ni de format publié ; clé de `sync_meta` seulement.

## Preuves

- **Rouge** : `77eff203` (tests seuls, `tests/unit/sync/visibleLosses.test.ts`) : `expected [] to include 'publish-dropped'` (le journal `publish-too-large` y est bien) et `expected [] to include 'received-unapplied'` après le plafond ; deux gardes-fous verts.
- **Vert** : commit de code suivant ; `bumpLossCounter` (`meta.ts`, factorise le compteur de TRI-24), `publisher.ts`, `maintenance.ts`, `engine.ts`, textes, `SyncDetailsRescue.tsx` (bouton de reprise aussi pour `publish-dropped`). `yTech02Warnings.test.tsx` : ordre attendu des avertissements étendu à `publish-dropped`.
- **Module** : `tests/unit/sync`, `src/sync`, `src/features/sync`, `src/i18n`, `src/domain` : **333 fichiers, 3 976 tests verts** ; lint et `tsc --noEmit` verts.
- **Bundle** : **338 748 normalisés**, marge 19 652 (plafond 358 400 inchangé), +262 face à `main` après TRI-24 (338 486) ; aucun module nouveau dans le départ.

## Passes

- **Product-owner** : « rendre l'échec visible seulement » respecté, aucun traitement du cas ; le critère 3 dit franchement ce que l'acquittement ne fait pas.
- **QA** : chemin normal inchangé (module entier vert) ; avertissement présent dans le cycle, après redémarrage, absent sans perte.
- **Revue à froid** : (1) compteur écrit avant le retrait : un arrêt entre les deux laisse un avertissement, pas un silence ; (2) `tooLargeCount` compte aussi les groupes refusés (table « group » non mémorisée) ; (3) l'avertissement est levé après l'étape 5 pour paraître dans le cycle de la perte ; (4) un `missing-parent` de report d'époque lève aussi `received-unapplied` en plus de `carry-held` : doublon accepté (deux causes possibles). Non couvert : appareil réel.
