# Checklist de l'ordre 5 (iPhone) : ce que les fiches de l'ordre 4 renvoient

Établie par le product-owner le 2026-10-06. Sources : fiches Y-01 à Y-11, A-09, docs/dettes.md (section « Ordre 5 »), docs/decisions.md, backlog (ordre 5 et P-04-iOS). Aucune commande iOS locale : builds par `.github/workflows/build-ios.yml`, installation par SideStore. Rappels : données et réglages à l'ordre 1, envoi sur l'iPhone à l'ordre 5 ; le PC n'envoie aucune notification de rappel.

## Synchro, parcours réels PC et iPhone

- [ ] Parcours 10 réel : même tâche modifiée hors ligne sur PC et iPhone, synchro, conflit visible dans le journal des deux côtés, « Restaurer », valeurs identiques (Y-04, Y-05, Y-02).
- [ ] Parcours 11 réel : scan du QR depuis Réglages → Synchronisation → Associer au PC, tâche créée sur le PC lisible sur l'iPhone, titre introuvable dans `iCloud Drive\CircleTasks` (Y-06 v11, Y-08).
- [ ] Lecture croisée : hydratation d'un fichier écrit par l'autre appareil (`startDownloadingUbiquitousItem`), état « En attente d'iCloud » puis reprise (Y-02 v6, Y-01).
- [ ] Fichier partiel ou encore dans le nuage d'un autre appareil, avec l'iPhone réel (Y-05 v4).
- [ ] iPhone sans dossier joignable : la file attend, rien n'est perdu (Y-05, plateforme).
- [ ] Message « L'horloge de {appareil} est en avance » vu depuis l'autre appareil, iPhone réglé en avance (Y-09 v3).
- [ ] Reprise depuis l'instantané d'un iPhone resté éteint plus de 180 jours, éléments supprimés non ressuscités (Y-09, simulé à l'ordre 4).
- [ ] Cycle de synchro au passage de l'iPhone en arrière-plan (« À la fermeture » côté iPhone, Y-02 ; decisions 2026-10-05).
- [ ] Bouton « Synchroniser » et section Réglages > Synchronisation visibles sur iPhone (`available()` vrai sur iOS, Y-01 critère 18, Y-03).

## Plateforme iOS de la synchro

- [ ] Signet de sécurité du dossier (plugin folder-bookmark), choix du dossier iCloud Drive/CircleTasks, `BookmarkFs`, refus des liens symboliques sous le signet (Y-01, dettes ordre 5).
- [ ] Trousseau : attributs de `circletasks.sync.key.v1` et `.next` relus par `SecItemCopyMatching` (`ThisDeviceOnly`, non synchronisés) ; compilation iOS de `vault_ios.rs` par la CI ; version de `security-framework` confirmée par `cargo tree --target aarch64-apple-ios` (Y-08 critères 17 et 19, Y-11).
- [ ] Scan du QR lancé par Rust (`sync_key_import({ scan: true })` avec le plugin barcode-scanner) ; sinon passage par le JS et avenant à l'ADR 0011 §2.1 (dettes ordre 5, Y-06).
- [ ] Confirmations natives iOS (affichage de la clé, remplacement de clé, oubli d'un appareil, réinitialisation) : « Annuler » par défaut, refus hors premier plan (Y-08, Y-10, Y-11).
- [ ] Saisie de la clé de secours sur iPhone (une seule WebView : limite documentée), progression de l'arrivée sur iPhone, écran Appairage.html (Y-06).
- [ ] Étape « Synchronisation » de l'assistant de premier lancement sur iPhone : 4 étapes quand la synchro est disponible, 3 sinon (Y-06 D5, P-05).
- [ ] Échec de réintégration affiché sur l'iPhone dès que le service de synchro y existe (dettes, Y-07).

## Versions, oubli, réinitialisation avec l'iPhone

- [ ] Y-07 version réelle : mettre l'iPhone à jour avant le PC par SideStore avec une migration additive ; le PC affiche « Mettez à jour l'app » et continue de lire ; après la mise à jour du PC, le bandeau disparaît, rien n'est perdu (Y-07 v3, I-06).
- [ ] Y-10 : oublier l'iPhone depuis le PC, iPhone éteint ; les fichiers de `devices\<iPhone>` disparaissent une fois les accusés réunis ; rallumer : « Cet appareil a été oublié », « Associer de nouveau », données locales conservées (Y-10 v5).
- [ ] Y-11 : réinitialiser depuis le PC, iPhone allumé puis éteint ; l'iPhone affiche « Cet appareil doit être associé de nouveau », scanne le nouveau QR, retrouve ses données et ses écritures hors ligne ; rappel après 30 jours simulés ou réels, sans oubli d'office (Y-11 v9).
- [ ] Bandeaux A-09 sur iPhone : marges de sécurité iOS, thème clair et sombre (A-09 critère 8 et 9h, non retestés en CSS).

## Rappels, notifications et appareil

- [ ] Recalcul des rappels après une synchro reçue (`onRemoteChanges`), rappel créé sur le PC qui sonne sur l'iPhone (Y-02 critère 18, N-07, N-01, N-05, N-06).
- [ ] Avertissement N-07 fondé sur `lastSyncHlc` (rafraîchi toutes les 30 minutes au plus, seuil de 2 h) : vérifier qu'il ne se déclenche pas à tort (decisions 2026-10-05, Y-02).
- [ ] Limite connue « rappel ressuscité à trois appareils » (docs/dettes.md, lot Y2) : relire avant d'envoyer les rappels.
- [ ] Rappels Apple (K-05 à K-07) et `calendar_account.username` sur iPhone avec les comptes synchronisés (Y-02 critère 10).

## Sauvegarde et restauration

- [ ] P-04-iOS : critère 11 de P-04, avenant à l'ADR 0009 (capability iOS, gestionnaire mobile, réouverture de la base sans `relaunch`), plugin Fichiers, règles 1 à 6 de l'ADR 0010 sur iPhone ; marqueur de restauration et fenêtre de choix de Y-02 sur iPhone (backlog, dettes).
- [ ] P-07 sur iPhone : « Télécharger un modèle » et rapport des lignes rejetées tant que le plugin Fichiers n'existe pas (dettes ; hors synchro, à garder en vue).

## Livraison

- [ ] I-01 installation : en suivant `docs/install-iphone.md`, SideStore puis CircleTasks installés en moins de 15 minutes (chronomètre, iTunes et iloader déjà téléchargés).
- [ ] I-01 premier lancement : après approbation du profil (Réglages > Général > VPN et gestion de l'appareil), CircleTasks s'ouvre sur l'écran Aujourd'hui.
- [ ] I-01 mise à jour : créer une tâche, installer la version suivante par SideStore (« Mettre à jour »), la tâche est toujours là.
- [ ] I-01 source : la source `https://raw.githubusercontent.com/doncivo/circletasks-releases/main/source.json` s'ajoute dans SideStore sans erreur et affiche l'icône et les notes de version.
- [ ] I-01 à I-06 (installation SideStore, expiration hebdomadaire, Face ID, logs, autorisations, mise à jour) puis REL-01 à REL-03 : les parcours 10 et 11 verts sur PC et iPhone entrent dans REL-01.
