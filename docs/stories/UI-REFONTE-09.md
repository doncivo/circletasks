# UI-REFONTE-09 — Réglages sur PC : sommaire à gauche, colonne de réglages bornée, la valeur près de son étiquette

Module : M12 Réglages · Palier : refontes après la 1.0.2, huitième et dernière des huit dans l'ordre d'Ali du 2026-10-27 · Agent : settings-personalization avec ui-design-system · Ouverte le 2026-10-28 par Claude Code.

Statut : **en CI, passes product-owner, module et revue écrites.** Estimation : 6 à 9 h actives ; alerte à 12 h.

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

- **Preuve rouge** : commit 7d7b2b70 (tests seuls) : `src/features/settings/SettingsPc.test.tsx` (5 tests, 4 rouges ; « iPhone inchangé » vert dès le départ, attendu), `tests/e2e/UI-REFONTE-09.spec.ts` (2 tests sur `pc`, clair et sombre, joués par la CI seule).
- **Vert ensuite** : commit 7287609b.
- **Aiguillage** (`SettingsScreen.tsx`) : `useLayout` ; PC → `SettingsScreenPc`, iPhone → l'écran existant renommé `SettingsScreenMobile`, inchangé.
- **Écran PC** (`SettingsScreenPc.tsx`) : `.ct-settings--pc` en deux colonnes ; sommaire collant (`h1` « Réglages », `nav` « Sections des réglages », huit boutons, `aria-current` sur la section courante, `scrollIntoView` au clic, `IntersectionObserver` au défilement avec un verrou de 800 ms après un clic) ; colonne `.ct-settings__content` bornée à 660 px ; huit `section` nommées par leur `h2`. « Général » : Thème, Début de semaine (jour en majuscule initiale), Format de l'heure (trois `LinkRow` vers Apparence, libellé accessible « étiquette : valeur »), Fuseau horaire en lecture seule (« Suit celui de Windows » sous l'étiquette, valeur sans « (automatique) »), Onglets visibles (`useTabCounts`, « 5 sur 5 »), Démarrer avec Windows avec sa mention. « Tâches », « Rappels », « Espaces et agendas » (Jours fériés y rejoint les agendas), « Synchronisation » (section et entrée du sommaire seulement si `useSyncAvailable()`), « Sauvegardes et données », « Clavier », « À propos » réutilisent les lignes et sections existantes.
- **Sections à titre optionnel** : `SyncSettingsSection`, `ShortcutsSettingsSection`, `AboutSection` reçoivent `heading?: boolean` (vrai par défaut : l'iPhone et les tests isolés ne changent pas) ; `useSyncAvailable` exporté par `SyncSettingsSection.tsx` ; `useTabCounts` par `TabsScreen.tsx`.
- **Clavier** (`ShortcutsSettingsSection.tsx`, PC seulement) : « Tous les raccourcis » devient une ligne cliquable (`.ct-settings__rowButton`, libellé accessible inchangé « Afficher les raccourcis clavier », `Kbd` « Ctrl / ») ; une combinaison prise (`status === 'unavailable'`) s'explique sous l'étiquette (`.ct-settings__hint[data-tone="warning"]`, « Ctrl+Alt+Espace est utilisé par une autre application. Choisissez-en un autre. »), touche en ambre (jetons `--ct-color-warning-*`), plus de barré ni de note « Indisponible : … ». Textes `helpRow`, `helpOpen`, `unavailableNote` retirés de `fr.shortcuts.ts` / `en.shortcuts.ts` (départ allégé).
- **Textes** : catalogue à la demande `src/i18n/settingsRefonteText.ts` (fr et en), chargé avec l'écran ; aucune clé nouvelle dans le départ.
- **Feuille de style** (`SettingsScreen.css`, bloc UI-REFONTE-09 ; `ShortcutsSettingsSection.css`) : sommaire, entrées, colonne, groupes (34 px), titres Fraunces 22, lignes de 46 px, chevron Lucide « chevron-right » en masque CSS sur chaque ligne cliquable, mention ambre, touche ambre.
- **Tests adaptés, avec trace « UI-REFONTE-09 »** : DOM `SettingsScreen.test` (joué à 440 : c'est l'écran iPhone), `SettingsScreen.desktop.test` (titres « Général » / « À propos » par rôle), `AppearanceScreen.test` (trois lignes), `TabsScreen.test` (« 5 sur 5 »), `shortcuts.dom.test` (phrase du conflit, « Tous les raccourcis ») ; e2e : aide `tests/e2e/helpers/settings.ts` (`settingsSectionTitle`, `settingsSectionHeading`, `appearanceRow`, `expectTimeZone`), `A-03`, `T-06`, `ES-01`, `ES-07`, `N-04`, `D-04`, `D-01`, `P-05`, `P-04`, `T-08`, `T-11`, `P-02`, `P-03`, capture `PC-Reglages` (`tests/visual/capture.spec.ts`).
- **Local** : suites `settings`, `shortcuts`, `sync`, `security`, `reminders`, `spaces`, `calendars`, `events` (1 705), `i18n`, `tests/unit`, `app` vertes ; lint ; typage. E2e en CI seulement (règle du 2026-10-28).

## Mesure du bundle

Avant push (commit 7287609b, build `--manifest`, `node tests/bundle/measureStart.ts`) : **337 432 octets normalisés** (brute 337 393), **marge 20 968** ; **−28** face à `main` 337 460 (textes `helpRow`, `helpOpen`, `unavailableNote` retirés du départ ; l'écran, ses sections et son catalogue sont à la demande ; garde 66/66). Mesure de `main` après fusion : à consigner.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

Relecture à froid du diff `7d7b2b70..7287609b` (aiguillage, écran PC, sections à titre optionnel, Clavier, catalogue, feuilles de style, tests) avant le premier passage en CI.

- **Vérifié sans remarque** : l'iPhone rend exactement l'ancien composant (renommé, corps inchangé) ; les trois sections qui portaient un titre gardent leur titre par défaut (`heading = true`), si bien que leurs tests isolés et l'iPhone ne changent pas ; les libellés accessibles des interrupteurs et boutons sont ceux d'avant (« Démarrer avec Windows », « Ouvrir la corbeille », « Afficher les raccourcis clavier », « Rechercher une mise à jour ») ; `LinkRow` reprend la forme « étiquette : valeur » des lignes existantes (`QuietHoursRows`, `SpacesSummaryRow`) ; le fuseau en lecture seule n'a pas de chevron (règle 3) ; la section « Synchronisation » et son entrée du sommaire disparaissent ensemble quand la plateforme ne la propose pas ; le verrou de 800 ms empêche l'observateur de défilement de reprendre une autre section juste après un clic du sommaire ; l'observateur est ignoré quand `IntersectionObserver` n'existe pas (jsdom) ; `scrollIntoView?.()` est optionnel pour la même raison.
- **Bundle** : aucun module nouveau dans le départ ; −28 octets (trois textes retirés). Le catalogue `settingsRefonteText.ts` n'est importé que par `SettingsScreenPc.tsx` et `ShortcutsSettingsSection.tsx`, tous deux hors du départ.
- **Point d'attention laissé à la QA** : le masque CSS du chevron (SVG en URL de données) dépend de `mask` / `-webkit-mask` (Chromium et WebKit : pris en charge) ; à vérifier à l'œil sur le PC avec la capture `PC-Reglages`. La position du sommaire (`position: sticky; top: 0`) suppose que `main` reste l'ancêtre défilant (c'est le cas de la coquille, `AppShell.css`).
- **Écart signalé au product-owner** : « Onglets visibles » affiche « 5 sur 5 » (Réglages non compté) là où la maquette montrait « 5 sur 6 » ; consigné dans le tableau des écarts.

Verdict : approuvée sous réserve de la CI complète (QA à consigner).
