# Corrections du PRD qui attendent Ali

Établi par le product-owner le 2026-10-06. Le PRD (docs/PRD.md) n'est jamais modifié par les agents ; une ligne par correction, avec la source et l'emplacement actuel dans le PRD (numéros de ligne au 2026-10-06). Proposition de texte entre guillemets quand elle existe.

## Synchro (M15, ordre 4)

1. M15, tableau l.297-305 : ajouter Y-10 « J'oublie un appareil » (validée par Ali le 2026-10-05) ; texte proposé dans docs/stories/Y-10.md, « Rappel PRD » (decisions.md 2026-10-05 et 2026-10-06).
2. M15 : ajouter Y-11 « Je réinitialise la synchronisation avec une nouvelle clé » (validée le 2026-10-05) ; texte proposé dans docs/stories/Y-11.md, « Rappel PRD » ; mettre aussi « Y-01 à Y-09 » en « Y-01 à Y-11 » l.804 (agent `sync-icloud`) et l.1316 (skill).
3. Y-09, l.305 (et l.555, l.739, l.1328) : « Trace de suppression conservée au moins 30 jours et tant que tous les appareils ne l'ont pas lue » (validé par Ali le 2026-10-05 ; les 30 jours sont comptés depuis la suppression).
4. Section 6, `sync_state`, l.530 : retirer `folder_bookmark_ref` (le chemin est gardé par Rust dans `sync/folder.json`) et ajouter les colonnes de schéma et de version (`schema_version`, `format_major`, `app_version`) ; décrire les tables locales de la migration 0015 (`sync_outbox`, `sync_field_clock`, `sync_guard`, `sync_tombstone`, `sync_parked`, `sync_unknown`, `sync_meta`) et corriger le total « 18 tables » (l.977).
5. Section 7, chiffrement, l.589 : « Web Crypto dans la WebView » devient « AES-256-GCM et HKDF-SHA256 en Rust (`aws-lc-rs`), la WebView ne voit que du texte clair ; clé dans le Gestionnaire d'identification / Trousseau » (decisions.md Y-08, 2026-10-05).
6. Section 7, fichiers, l.610-612, l.1325 et l.1332 : `changes-pc.jsonl`, `changes-iphone.jsonl` et `snapshot.json` deviennent un dossier par appareil `devices/<device_id>/` avec `state.ctx`, segments `j-<n>.ctj` (ajout seul, 1 Mio) et instantanés `s-<n>.cts` par époque (decisions.md Y-02).
7. Y-02, l.298 : « à la fermeture » s'entend sur PC comme « au masquage de la fenêtre et avant Quitter » (5 s au plus) ; sur iPhone au passage en arrière-plan (decisions.md Y-02).
8. Y-04, l.300 : ajouter « journal conservé 12 mois » (le PRD ne fixait rien) et la définition d'un conflit (deux modifications du même champ sans que l'une ait vu l'autre) (decisions.md Y-04).
9. Y-06 et Y-08, l.302 et l.304 : « clé créée au premier appairage » devient « créée au choix du dossier sur le premier appareil » ; QR valable 5 minutes ; un appareil qui rejoint avec des données les fusionne (decisions.md Y-06).
10. Y-07, l.303 et l.616 : préciser « version majeure = version du format de synchro (`SYNC_FORMAT_MAJOR`), `schema_version` = dernier numéro de migration » (decisions.md Y-07).
11. A-09, l.162 (section M2) : « Synchro en cours » n'apparaît qu'au-delà de 1 s ; ajouter les bandeaux d'échec de synchro (« Voir »), « Mettez à jour l'app » et l'ordre de priorité (decisions.md A-09, 2026-10-06).
12. P-05 (M12) : l'étape d'association est présente seulement si la synchro est disponible (4 étapes sur PC, 3 sinon) (decisions.md Y-06, 2026-10-05).

## Écarts hérités des ordres 1 à 3 marqués « PRD à mettre à jour par Ali »

13. SD-03, l.339 : « Plus tard » devient « Un jour » (decisions.md 2026-10-02 ; maquettes de référence).
14. A-06, l.159 : en vue compacte les heures sont affichées, pas masquées (decisions.md 2026-10-02).
15. OB-06, l.331 : l'historique est dans la section « SEMAINES PRÉCÉDENTES » de l'écran Objectif, pas dans Statistiques (decisions.md 2026-10-03).
16. E-01, l.213 : rappels d'événement « 1 semaine avant » (10080), 1 jour (1440) et à l'heure (0 min) (decisions.md 2026-10-03).
17. E-04, l.216 : « J-n » sur tous les événements à venir de la liste ; le champ « important » commande les bandeaux d'Aujourd'hui et de la Semaine (decisions.md 2026-10-03 et 2026-10-04).
18. F-04, l.248 et section 7 l.376 : sur PC le son seul (interrupteur « Son de fin de session ») ; sur iPhone son et notification (decisions.md 2026-10-04).
19. H-01, l.254 : quatre tuiles (tâches faites, routines, Focus, objectifs), pas « événements » (decisions.md 2026-10-04).
20. Section 6, `focus_session`, l.526 : ajouter `paused_at` ; `planned_min` nul = Libre (decisions.md 2026-10-04, F-01).
21. Section 6, `focus_session`, l.526 : ajouter `project_id` figé au lancement (migration 0014) (decisions.md 2026-10-04, ES-08).
22. Section 6, thème, l.549 : le thème est local (`ui.theme`), pas une préférence partagée ; `general.theme` est sans usage (docs/dettes.md, decisions.md 2026-10-04 P-02).
