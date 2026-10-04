# ADR 0010 — Restauration de la base et synchronisation

- Statut : accepté
- Date : 2026-10-05
- Stories : P-04 (restauration, ordre 3) ; contraint Y-01 à Y-09 (M15, ordre 4) et l'ouverture de P-04 à l'iPhone (ordre 5)
- Complète : ADR 0005 (HLC), ADR 0009 (avenant P-04)

## Contexte

P-04 remplace TOUTE la base locale (`circletasks.db`) par une version plus ancienne, puis relance l'app. À l'ordre 3 il n'existe aucune synchro : l'opération est purement locale et sûre (avenant P-04 de l'ADR 0009). À l'ordre 4, la synchro (journaux chiffrés dans iCloud Drive, fusion champ par champ au hlc le plus élevé, ADR 0005) rendra cette opération dangereuse si rien n'est prévu :

1. **Réutilisation d'identifiants publiés.** La base restaurée contient l'état de synchro de la date de la sauvegarde (numéro de journal, curseurs, hlc maximal) avec le même `device.id`. Sans précaution, l'appareil republierait des numéros de journal ou des hlc déjà publiés : les autres appareils liraient deux contenus différents sous le même identifiant.
2. **Régression du hlc.** `bootstrapApp` amorce l'horloge par `SyncMetaRepository.maxHlc()` de la base restaurée. L'horloge physique suffit d'ordinaire à repasser au-dessus des hlc déjà publiés, mais pas si l'appareil avait reçu un hlc distant en avance (dérive non bornée, dette d'ordre 4).
3. **Effet sur les données.** Avec des curseurs anciens, la synchro suivante rejoue les journaux de tous les appareils depuis la date de la sauvegarde : tout ce que la restauration voulait défaire réapparaît (et les suppressions reviennent). La restauration serait silencieusement annulée.
4. **Traces de suppression.** Une version plus ancienne que la durée de conservation des traces (Y-09 : lecture par tous, puis 30 jours ; 180 jours hors ligne) peut ressusciter des éléments supprimés ailleurs.

## Décision

### Ordre 3 (en vigueur)

- La restauration reste locale, PC seulement, depuis le seul dossier `backups/` de l'app (aucun fichier extérieur : la WebView transmet un nom, jamais un chemin). Toutes les versions de ce dossier ont été écrites par cet appareil : même `device.id`, aucune collision d'identité possible.
- Aucun changement de code n'est demandé à P-04 par cet ADR.

### Règles imposées à la synchro (ordre 4), non négociables

1. **L'état publié fait foi, pas la base locale.** Avant toute publication, l'appareil lit dans iCloud Drive son propre dernier numéro de journal et son hlc maximal publié, et appelle `HlcClock.receive(hlcMaxPublié)`. Le numéro suivant est `max(local, publié) + 1`. Ainsi une base restaurée (ou une base reconstruite) ne réutilise jamais un identifiant publié.
2. **Une restauration est détectable.** Après un échange réussi, `restore_backup` (Rust) écrira un marqueur durable hors de la base (`restore-marker.json` dans le dossier de données de l'app : nom de la version, horodatage, version de schéma). Ce marqueur est ajouté par sync-icloud à l'ordre 4 (sans synchro, il est inutile) ; il est consommé et supprimé par la première synchro qui suit.
3. **Pas de synchro automatique après une restauration.** Tant que le marqueur existe, la synchro est suspendue et l'app demande un choix explicite (texte dans `src/i18n`, story à rattacher à Y-02 ou Y-04) :
   - **« Appliquer cette version sur tous mes appareils »** : l'appareil ouvre une nouvelle *époque* de synchro, publie un instantané complet de la base restaurée marqué de cette époque, et les journaux des époques précédentes sont ignorés. Les autres appareils, en voyant une époque plus récente, publient d'abord leurs écritures non publiées, puis repartent de l'instantané et rejouent par-dessus ces seules écritures (hlc postérieur au dernier publié) ;
   - **« Garder les données synchronisées »** : les curseurs de lecture sont remis à zéro et l'appareil repart du dernier instantané publié (chemin Y-09 « reprise depuis l'instantané ») ; la restauration n'a alors d'effet que sur les données locales non synchronisées. La copie `circletasks-pre-restore-…` reste disponible.
4. **Âge de la version.** Si la version restaurée est plus ancienne que la plus ancienne trace de suppression encore conservée, seule l'option « Appliquer sur tous mes appareils » (époque nouvelle) est proposée : le rejeu de journaux ne doit jamais ressusciter un élément supprimé (Y-09).
5. **Identité de l'appareil.** Restaurer un fichier qui ne vient pas de cet appareil (autre `device.id`, import d'une base externe, P-04 hors périmètre aujourd'hui) impose un nouveau `device.id` avant toute écriture. Tant que la restauration est limitée au dossier `backups/` de l'app, cette règle n'a pas d'effet.
6. **Données locales.** Les réglages de portée `local` (dont `device.id`, `onboarding.*`, `sample.ids`) et l'état de synchro sont restaurés avec la base ; la règle 1 rend l'état de synchro restauré inoffensif. Les tables locales non synchronisées (`search_index`, `external_event`) sont reconstruites comme d'habitude.

### Ordre 5 (iPhone)

L'ouverture de P-04 à l'iPhone (capability `platforms: ["iOS"]`, gestionnaire mobile, remplacement de `relaunch` qui n'existe pas sur iOS par une réouverture de la base dans le processus) applique les mêmes règles 1 à 6 ; elle fera l'objet d'un avenant à l'ADR 0009.

## Conséquences

- L'ADR de synchro (ordre 4) reprend ces six règles et précise le format de l'époque, de l'instantané et du marqueur ; sync-icloud ajoute le marqueur dans `backup.rs` et ses tests `cargo test` (restaurer, marquer, synchroniser : aucune donnée défaite ne réapparaît, aucun numéro de journal réutilisé).
- La feuille de restauration (P-04) devra, à l'ordre 4, avertir avant confirmation que l'appareil est associé et que le choix sera demandé à la prochaine synchro.
- Dette inscrite (docs/dettes.md, ordre 4) : « Restauration P-04 et synchro : appliquer l'ADR 0010 ».
- Alternatives écartées : ré-horodater toutes les lignes restaurées pour qu'elles gagnent la fusion (coûteux, ne traite pas les éléments créés après la sauvegarde, qui resteraient) ; interdire la restauration sur un appareil associé (prive l'utilisateur de son filet de sécurité).
