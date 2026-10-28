# UI-REFONTE-09 — Réglages sur PC : sommaire à gauche, colonne de réglages bornée, la valeur près de son étiquette

Module : M12 Réglages · Palier : refontes après la 1.0.2, huitième et dernière des huit dans l'ordre d'Ali du 2026-10-27 · Agent : settings-personalization avec ui-design-system · Ouverte le 2026-10-28 par Claude Code.

Statut : **ouverte, passe product-owner écrite.** Estimation : 6 à 9 h actives ; alerte à 12 h.

Références : `docs/maquettes-refonte/PC-Reglages.html`, huit règles transversales du README du même dossier. Écran de départ : `src/features/settings/SettingsScreen.tsx`, `SettingsScreen.css`, `AboutSection.tsx`, `src/features/shortcuts/ShortcutsSettingsSection.tsx` (+ `.css`), `src/features/sync/SyncSettingsSection.tsx`, lignes partagées (`BackupRow`, `ImportRow`, `SampleDataRow`, `SecuritySection`, `QuietHoursRows`, `SpacesSummaryRow`, `CalendarsSummaryRow`, `HolidaysSummaryRow`, `FocusSoundSetting`). Écran à la demande (`lazyScreens.tsx`) : rien n'entre dans le départ.

## Passe product-owner

### Ce que la maquette change (et ce qu'elle ne change pas)

Sur grand écran, on borne et on navigue (règle 7). **Un sommaire à gauche** (220 px, titre « Réglages » en Fraunces 30) liste les huit sections ; **la colonne de réglages est bornée à 660 px**, si bien que la valeur reste près de son étiquette au lieu de partir à 1 800 px. Les titres de section passent de petites capitales espacées (« GÉNÉRAL ») à des titres Fraunces 22 en minuscules (« Général »). La ligne « Thème · semaine · heure » redevient **trois lignes** (Thème, Début de semaine, Format de l'heure), chacune avec sa valeur et un chevron ; « Onglets » devient « Onglets visibles · 5 sur 5 » ; « Fuseau horaire » dit « Suit celui de Windows » sous son étiquette au lieu de « (automatique) » après la valeur ; « Démarrer avec Windows » explique ce qu'il fait (« CircleTasks s'ouvre réduit dans la zone de notification », D-02 critère 4). Dans « Clavier », **un raccourci pris par une autre application s'explique en une phrase** sous l'étiquette (« Ctrl+Alt+Espace est utilisé par une autre application. Choisissez-en un autre. ») au lieu d'être barré à côté d'un interrupteur allumé ; « Tous les raccourcis » devient une ligne cliquable avec son raccourci « Ctrl / » et un chevron.

Ne changent pas : l'iPhone (écran, textes, tests), les écrans de second niveau (Apparence et formats, Onglets, Récapitulatifs, Heures calmes, Espaces, Agendas, Jours fériés, Synchronisation, Corbeille, Import, Logs), la feuille de restauration, les réglages eux-mêmes et leur enregistrement, les libellés accessibles existants des interrupteurs et des boutons (« Démarrer avec Windows », « Reporter les tâches non faites », « Ouvrir la corbeille », « Rechercher une mise à jour », « Afficher les raccourcis clavier »…).

### Écarts avec le PRD et les maquettes, assumés

| Source | Formulation | Choix de la story |
| --- | --- | --- |
| Maquette | sommaire « Sauvegardes » | section « Sauvegardes et données » : elle porte aussi l'import CSV, les données d'exemple et la Corbeille (T-08, Q6 : unique point d'accès) |
| Maquette | chevron sur « Fuseau horaire » | pas de chevron : la ligne est en lecture seule (T-11 critère 5) ; règle 3 (aucune commande qui ne peut rien faire) |
| T-11 | « Europe/Paris (automatique) » | sur PC : valeur « Europe/Paris », mention « Suit celui de Windows » sous l'étiquette ; l'iPhone garde « (automatique) » |
| P-01, maquette | « Onglets · 5 visibles » ; « 5 sur 6 » | sur PC : « Onglets visibles · 5 sur 5 » (Réglages, toujours affiché, ne compte pas, comme dans l’écran Onglets ; la maquette le comptait) |
| P-02, P-03 | une ligne « Thème · semaine · heure » | trois lignes sur PC, qui ouvrent le même écran « Apparence et formats » |
| Reglages.html (septembre) | « Jours fériés » dans TÂCHES | sur PC : dans « Espaces et agendas » (les fériés sont des agendas) ; l'iPhone ne bouge pas |
| D-04, P-08 | « Raccourcis clavier · Afficher », « Indisponible : combinaison prise par une autre application » barrée | « Tous les raccourcis · Ctrl / » (ligne cliquable, même libellé accessible « Afficher les raccourcis clavier ») ; phrase d'explication sous « Capture rapide », touche en ambre, plus de barré |

À ajouter à PRD-02 : T-11 (forme du fuseau sur PC), P-01 (« 5 sur 5 »), P-02/P-03 (trois lignes), D-04/P-08 (phrase du conflit, ligne « Tous les raccourcis »).

### Critères

1. **Sommaire** (PC) : `.ct-settings__summary` à gauche, 220 px, collant au défilement ; `h1` « Réglages » (Fraunces 30) ; `nav` « Sections des réglages » avec huit boutons dans l'ordre : Général, Tâches, Rappels, Espaces et agendas, Synchronisation, Sauvegardes et données, Clavier, À propos ; le bouton de la section courante porte `aria-current="true"` ; un clic fait défiler la section en vue (`scrollIntoView`) et la rend courante ; le défilement met à jour la section courante (`IntersectionObserver` quand il existe).
2. **Colonne de réglages** `.ct-settings__content` : largeur maximale 660 px ; huit `section` nommées par leur `h2` (`.ct-settings__section`, Fraunces 22, minuscules) ; 34 px entre deux sections.
3. **Général** : « Thème » (valeur Système / Clair / Sombre), « Début de semaine » (« Lundi »…), « Format de l’heure » (« 24 h » / « 12 h ») : trois boutons `.ct-settings__rowButton` avec chevron qui ouvrent « Apparence et formats » ; « Fuseau horaire » (lecture seule) avec « Suit celui de Windows » sous l'étiquette et la zone en valeur, sans « (automatique) » ; « Onglets visibles » « 5 sur 5 » (visibles sur total hors Réglages ; chevron, écran Onglets) ; « Démarrer avec Windows » avec « CircleTasks s’ouvre réduit dans la zone de notification » et l'interrupteur (libellé accessible inchangé). La ligne « Thème · semaine · heure » n'existe plus sur PC.
4. **Tâches** : « Reporter les tâches non faites », « Masquer les routines de la liste », son de fin de session (F-04). **Rappels** : « Récapitulatifs », heures calmes par espace. **Espaces et agendas** : « Espaces et projets », « Agendas · Rappels Apple », « Jours fériés ». **Synchronisation** : la section existante sans son propre titre. **Sauvegardes et données** : sauvegarde automatique, import CSV, données d'exemple, Corbeille (et « Verrouillage Face ID » quand il existe). **À propos** : la section existante sans son propre titre. Toutes les lignes cliquables portent un chevron (CSS, trait Lucide).
5. **Clavier** : « Capture rapide » (app installée) : touche et interrupteur ; quand la combinaison est prise (`status === 'unavailable'`), la phrase « {touches} est utilisé par une autre application. Choisissez-en un autre. » sous l'étiquette (`.ct-settings__hint[data-tone="warning"]`), touche en ambre (`--ct-color-warning-*`), plus de barré ni de note « Indisponible : … » ; « Tous les raccourcis » : ligne cliquable (libellé accessible « Afficher les raccourcis clavier »), `Kbd` « Ctrl / », chevron.
6. **Sombre** : jetons existants (`--ct-color-border`, `--ct-color-text-secondary`, `--ct-color-warning-*`) ; aucune paire nouvelle.
7. **iPhone** : aucune différence de rendu ni de test (titres en capitales, « Thème · semaine · heure », « (automatique) », « DONNÉES ET SÉCURITÉ »).
8. **Bundle de départ** : l'écran et ses sections sont à la demande ; textes nouveaux dans `src/i18n/settingsRefonteText.ts` chargé avec l'écran ; aucun module nouveau dans `start-modules.json` ; mesure avant push, attendue à ± 0.
9. **Tests** : e2e PC existants adaptés avec trace (titres de section par une aide `tests/e2e/helpers/settings.ts`, lignes « Thème », fuseau) sans changer un comportement.

### Preuves attendues

- **Rouge d'abord** : `src/features/settings/SettingsPc.test.tsx` (sommaire et sections, Général en six lignes, Clavier, sections des lignes partagées, iPhone inchangé) ; e2e `tests/e2e/UI-REFONTE-09.spec.ts` sur `pc` (clair et sombre).
- **Vert ensuite** : suites `settings`, `shortcuts`, `sync`, `security` (adaptations tracées : `SettingsScreen.test` joué à 440, `SettingsScreen.desktop.test`, `AppearanceScreen.test`) ; e2e `A-03`, `T-06`, `T-08`, `T-11`, `D-01`, `D-04`, `ES-01`, `ES-07`, `N-04`, `P-02`, `P-03`, `P-04`, `P-05`, `capture.spec` (maquette `PC-Reglages.html`) ; lint ; typage ; garde du bundle ; CI complète.

### Hors périmètre

Le PRD ; l'iPhone ; les écrans de second niveau ; la fenêtre d'appairage ; toute logique de réglage.

## Passe agent du module

À écrire après la preuve rouge.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

À écrire.
