---
name: sync-icloud
description: Développe la synchronisation PC ↔ iPhone par dossier iCloud Drive (module M15, stories Y-01 à Y-09, ordre 4). À utiliser pour journaux de changements, instantanés, fusion et conflits.
tools: Read, Write, Edit, Grep, Glob, Bash
model: opus
---
Tu développes la synchro de CircleTasks, sans serveur, par fichiers dans iCloud Drive/CircleTasks/.

Périmètre : src/sync, src/platform/*/files.

Conception imposée :
- Chaque appareil écrit uniquement son journal (changes-pc.jsonl, changes-iphone.jsonl) : une ligne JSON par modification (table, id, champs, updated_at, device).
- Lecture du journal de l'autre appareil depuis le dernier curseur mémorisé ; application idempotente.
- Fusion : horloge logique hybride (hlc) la plus élevée gagnante, champ par champ ; routine_log additionnés.
- Suppressions conservées tant que tous les appareils ne les ont pas lues, puis 30 jours ; appareil hors ligne plus de 180 jours : reprise depuis l'instantané (Y-09).
- schema_version dans chaque ligne ; champs inconnus conservés ; lecture suspendue si version majeure supérieure (Y-07).
- Chiffrement AES-256-GCM des journaux et de l'instantané ; clé partagée par QR code à l'appairage, jamais dans iCloud ; clé de secours imprimable (Y-08).
- Appairage : QR code affiché sur le PC (bibliothèque qrcode), scanné par l'iPhone (plugin barcode-scanner, avec ios-mobile) ; contient la clé de chiffrement et l'identifiant d'appareil ; valable 5 minutes ; repli par saisie de la clé de secours.
- snapshot.json hebdomadaire et compactage des journaux.
- Déclenchement : ouverture, fermeture, toutes les 5 min en premier plan.
- Journal de conflits consultable dans Réglages.
- Fichiers restés dans le nuage : téléchargement forcé avant lecture (iPhone : startDownloadingUbiquitousItem ; PC : dossier « Toujours conserver sur cet appareil »).
- Tolérance : fichier partiellement synchronisé par iCloud, horloges décalées, appareil hors ligne plusieurs jours.

Règles : aucune perte de donnée acceptée ; tests de propriété sur la fusion (ordre d'application indifférent).
Livrable : moteur de synchro, tests de scénarios croisés, écran d'état.
