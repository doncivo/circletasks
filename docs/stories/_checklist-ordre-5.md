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
- [ ] Scan du QR par le JS (ADR 0011 §23 point 2 : aucune API Rust du plugin barcode-scanner) : texte passé aussitôt à `sync_key_import({ qrText })`, jamais gardé (troisième point d'exposition, §2.1) ; vérifier sur l'iPhone la demande d'autorisation de la caméra et le refus visible (dettes ordre 5, Y-06).
- [ ] Confirmations natives iOS (remplacement de clé, « Oublier le dossier et la clé », oubli d'un appareil, réinitialisation ; jamais « Afficher la clé » : l'iPhone n'affiche pas le QR, ADR 0011 §23 point 3) : « Annuler » par défaut, refus hors premier plan (Y-08, Y-10, Y-11).
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

## Phase 1 : lot N1 (notifications), ajouté par le product-owner le 2026-10-08

Sources : fiches N-01, N-03, N-05, N-06, N-07, compléments de F-04 et N-04. Rien de ceci n'est vérifiable sans l'iPhone ; les critères unitaires, e2e (projet `iphone`) et la CI verte sont dans les fiches.

- [ ] N-01 A1 : rappel à 09:00 reçu à 09:00:xx (≤ 60 s), app fermée puis écran verrouillé.
- [ ] N-01 A2 : autorisation refusée, bandeau visible ; rétablie dans Réglages iOS, bandeau disparu à la reprise.
- [ ] N-01 A3 : nombre réel de notifications en attente ≤ 64 et texte « Planifiés jusqu'au » conforme.
- [ ] N-05 A1 et A2 : redémarrage de l'iPhone puis fermeture forcée, les rappels planifiés sonnent, aucun doublon à la réouverture.
- [ ] N-05 A3 : mise à jour par SideStore, notifications conservées ou replanifiées (noter lequel).
- [ ] N-05 A4 et A5 : app non ouverte plusieurs jours (plafond, « planifiés jusqu'au »), réinstallation après expiration des 7 jours.
- [ ] N-06 A1 à A3 : changement de fuseau avec réouverture ; **sans réouverture, noter si la notification sonne à l'ancien instant** (décide l'option de l'ADR 0012) ; heure d'été.
- [ ] N-07 A1 à A3 : tâche créée sur le PC, sonne sur l'iPhone, rien sur le PC ; avertissement PC (rappel à moins de 2 h, iPhone ancien) sans fausse alerte ; récapitulatif du lendemain en texte générique puis réel.
- [ ] **N-03 A2 (bloquant pour la clôture de N-03)** : notification planifiée, app tuée, appui sur « Fait » puis « +15 min » : l'app ne s'arrête pas (constat 6 de l'ADR 0012) ; idem après redémarrage et après mise à jour SideStore. Résultat noté dans l'ADR 0012.
- [ ] N-03 A1, A4, A5 : « Fait » en premier plan, « +15 min » (sonne 15 min plus tard, tâche inchangée, rien reçu par le PC), « Fait » sur routine valide la bonne date.
- [ ] F-04 (complément) : fin de session app fermée, une seule notification après pause et reprise, une seule alerte app ouverte, sonne pendant une plage silencieuse Pro, bandeau si l'autorisation est refusée.
- [ ] N-04 (complément) : récapitulatif du soir à l'heure avec le contenu du jour ; changement d'heure dans Réglages sans ancienne notification.

## Phase 1 : lot Y-IOS (synchro sur iPhone), ajouté par le product-owner le 2026-10-08

Sources : fiches Y-IOS-01 et Y-IOS-02. Les cases de « Synchro, parcours réels » et « Plateforme iOS de la synchro » ci-dessus restent la liste de référence ; ces lignes ajoutent ce que les fiches exigent en plus.

- [ ] Y-IOS-01 A1 à A3 : signet retenu après redémarrage ; hydratation d'un fichier « dans le nuage » ; lien symbolique refusé et visible.
- [ ] Y-IOS-01 A4 : cycle au passage en arrière-plan, tâche créée sur l'iPhone arrive sur le PC écran verrouillé ; durée réelle de la tâche d'arrière-plan notée (cible ~25 s).
- [ ] Y-IOS-01 A5 et A6 : signet après mise à jour SideStore (ou invitation visible à rechoisir) ; iPhone hors ligne, la file attend.
- [ ] Y-IOS-02 A1 : parcours 11 réel (QR, caméra expliquée, dossier, tâche lisible, titre absent d'iCloud).
- [ ] Y-IOS-02 A2 : attributs du Trousseau (`SecItemCopyMatching`), absence sur un second appareil du même Apple ID.
- [ ] Y-IOS-02 A3 : alerte `UIAlertController` (« Annuler » par défaut, refus hors premier plan, compteurs après fermeture forcée, mode sombre).
- [ ] Y-IOS-02 A4 : heure de la boîte d'oubli en heure locale.
- [ ] Y-IOS-02 A5 et A6 : oubli, réinitialisation et version réelle avec l'iPhone ; saisie de la clé de secours, progression, assistant à 4 étapes.
- [ ] Échec de réintégration visible sur l'iPhone (Y-07) et bandeaux A-09 : marges de sécurité iOS, thèmes clair et sombre.

## Phase 2 : lots K (calendriers et Rappels Apple) et M (iPhone), ajouté par le product-owner le 2026-10-08

Sources : fiches K-TECH-01, K-05, K-06, K-07, A-07, Q-05, I-03, I-02. Les critères unitaires, e2e (projet `iphone`) et la CI verte sont dans les fiches. Prérequis d'Ali pour K-TECH-01 : ID client Google « iOS » (bundle `fr.circletasks.planner`) dans le secret GitHub `CT_GOOGLE_IOS_CLIENT_ID`.

- [ ] K-TECH-01 A1 à A5 : connexion Google réelle sur l'iPhone, annulation, session Safari partagée, jeton révoqué (« Reconnecter »), compte créé sur le PC (« Reconnecter » sur l'iPhone).
- [ ] K-05 A1 à A6 : fenêtre d'accès aux Rappels (refus puis rétablissement), vraies listes importées (rappels sans date dans « Un jour »), modification dans Rappels vue sans relancer, suppression et liste décochée, rappel récurrent (noter), plafond de 500.
- [ ] K-06 A1 à A5 : terminer des deux côtés, modification croisée (gagnant noté, journal des conflits), réglage de création par espace (rappel dans la bonne liste), accès révoqué pendant une modification (bandeau et file).
- [ ] K-07 A1 à A4 : rappel créé dans Rappels visible sur le PC (délai noté), tâche cochée sur le PC et état dans Rappels (arrière-plan ou ouverture, noter), heure de dernière mise à jour et avertissement après 24 h, trois états identiques après modifications croisées.
- [ ] A-07 A1 à A5 : retours haptiques (un par geste), pas de déclenchement au défilement ni au bord gauche, VoiceOver (actions Reporter, Un jour, Supprimer), réduction des animations, Semaine (appui long = glisser, balayage de ligne sans changer de semaine).
- [ ] Q-05 A1 à A4 : **le clavier apparaît au toucher du bouton +** (sinon le correctif du critère 3 est repris), bouton utilisable en moins de 1 s à froid (et derrière le verrou, I-03), dictée du clavier, clavier ouvert sans zone coupée.
- [ ] I-03 A1 à A7 : Face ID réel à l'activation et au lancement, repli sur le code, **aperçu du sélecteur d'apps sans contenu**, 30 s de reverrouillage, excursion (caméra du scan) sans reverrouillage, synchro et notification pendant le verrou, mise à jour SideStore avec le verrou actif, texte de la demande.
- [ ] I-03, cache natif `privacy-shield` (construit dès le lot M) : sélecteur d'apps ouvert **sans quitter l'app** (balayage vers le haut maintenu) et centre de contrôle : aperçu opaque, aucune tâche ; retour : contenu sans clignotement ; Réglages › DONNÉES ET SÉCURITÉ sans message « cache de confidentialité » ; fenêtre Face ID affichée normalement par-dessus le cache.
- [ ] Plugin `haptics` (lot M, partie 1, avant A-07) : aucun message « haptics-failed » dans le journal technique au premier geste (contrôlé avec A-07 A1).
- [ ] I-02 A1 à A5 : date d'expiration lue (7 jours, noter l'écart avec SideStore), actualisation SideStore (alerte remplacée), alerte réelle (≤ 60 s, texte conforme), alerte après actualisation en arrière-plan (noter), réinstallation après expiration.
- [ ] Contrat Info.plist de l'IPA de la phase 2 : `NSRemindersFullAccessUsageDescription` et `NSFaceIDUsageDescription` présentes et en français ; aucune clé en trop (notifications, haptique, web-auth, signature : aucune).
- [ ] Règle d'Ali : parcourir les états d'échec créés par la phase 2 sur l'appareil (accès Rappels refusé, écritures en attente, Google non configuré, verrou impossible, date d'expiration inconnue) : chacun est visible dans Réglages, la fiche ou un bandeau, et disparaît à la résolution.

## Point de contrôle de 15 minutes après la phase 1 (demandé par Ali)

Objectif : valider en une séance courte que la chaîne tient, avant d'empiler les phases 2 à 4. IPA produite par `build-ios.yml` sur la branche fusionnée de la phase 1 et signalée à Ali par l'agent de coordination. Chronomètre lancé à l'ouverture du guide `docs/install-iphone.md`.

1. [ ] Installer l'IPA par SideStore (SideStore déjà installé, sinon compter le temps en plus) ; approuver le profil ; l'app s'ouvre sur Aujourd'hui.
2. [ ] Accepter les notifications (explication affichée avant la fenêtre iOS) ; refuser une fois pour voir le bandeau, puis autoriser.
3. [ ] Choisir le dossier `iCloud Drive/CircleTasks` avec le sélecteur ; redémarrer l'app, le dossier est retenu.
4. [ ] Scanner le QR affiché sur le PC (caméra expliquée) ; la tâche du PC apparaît sur l'iPhone.
5. [ ] Créer une tâche à +3 minutes avec « À l'heure » ; verrouiller l'écran ; la notification sonne ≤ 60 s après l'heure.
6. [ ] Appuyer sur « +15 min » puis « Fait » (app ouverte, puis app tuée : N-03 A2) ; la tâche reste intacte après « +15 min ».
7. [ ] Réglages > Rappels affiche « Planifiés jusqu'au… » ; Réglages > Synchronisation affiche « Dernière synchro ».
8. [ ] Noter tout bandeau d'erreur vu, avec l'heure ; noter la durée totale (cible : 15 minutes hors installation de SideStore).

Résultat à inscrire ici par Ali : date, durée, cases non cochées. Un blocage de ce point de contrôle arrête la phase 2.

## Livraison

- [ ] I-01 installation : en suivant `docs/install-iphone.md`, SideStore puis CircleTasks installés en moins de 15 minutes (chronomètre, iTunes et iloader déjà téléchargés).
- [ ] I-01 premier lancement : après approbation du profil (Réglages > Général > VPN et gestion de l'appareil), CircleTasks s'ouvre sur l'écran Aujourd'hui.
- [ ] I-01 mise à jour : créer une tâche, installer la version suivante par SideStore (« Mettre à jour »), la tâche est toujours là.
- [ ] I-01 source : la source `https://raw.githubusercontent.com/doncivo/circletasks-releases/main/source.json` s'ajoute dans SideStore sans erreur et affiche l'icône et les notes de version.
- [ ] I-01 à I-06 (installation SideStore, expiration hebdomadaire, Face ID, logs, autorisations, mise à jour) puis REL-01 à REL-03 : les parcours 10 et 11 verts sur PC et iPhone entrent dans REL-01.
