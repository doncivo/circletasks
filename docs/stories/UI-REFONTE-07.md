# UI-REFONTE-07 — Événements sur iPhone : vos événements gardent l'encre, les fériés reculent, le pays s'écrit en toutes lettres

Module : M7 Événements · Palier : refontes après la 1.0.2, sixième des huit dans l'ordre d'Ali du 2026-10-27 · Agent : checklists-events avec ui-design-system · Ouverte le 2026-10-28 par Claude Code.

Statut : **ouverte, passe product-owner écrite.** Estimation : 3 à 5 h actives ; alerte à 8 h.

Références : `docs/maquettes-refonte/Evenements-v2.html`, huit règles transversales du README du même dossier. Écran de départ : `src/features/events/EventsScreen.tsx`, `EventRow.tsx`, `eventTags.ts`, `holidayText.ts`, `EventsScreen.css`, textes `src/i18n/fr.events.ts` / `en.events.ts`. Écran à la demande (`lazyScreens.tsx`). **Périmètre : la mise en page iPhone** (`useLayout() === 'mobile'`) ; la liste PC et son volet (PC-Evenements.html) ne changent pas, hors la sous-ligne des fériés, commune.

## Passe product-owner

### Ce que la maquette change (et ce qu'elle ne change pas)

La liste par mois reste (jour en Fraunces et jour de la semaine, titre, sous-ligne, compte à rebours, passé grisé, ouverture sur aujourd'hui). Ce qui change : **les badges colorés disparaissent** (« Férié FR », « Férié TN ») : le pays s'écrit en toutes lettres dans la sous-ligne (« Jour férié en Tunisie », « Jour férié en France · date estimée ») et les lignes de fériés **reculent en gris** ; vos événements gardent toute l'encre et leur compte à rebours. Une pastille **« Masquer les fériés »** à droite des pastilles d'espace les retire de la liste le temps de la consultation (« Afficher les fériés » pour les remettre) ; les calendriers restent activés dans Réglages (E-03). Plus de filet décoratif. Le bas de l'écran devient une rangée : **« Vue calendrier »** au trait (prend la largeur) et un bouton plein **« Événement »** avec un « + » (libellé accessible « Ajouter un événement », inchangé) ; plus de bouton flottant. Rien n'est retiré : feuille Ajout au segment Événement, fiche d'un événement local, fiche d'un jour férié (date modifiable), grille du mois en feuille, filtre d'espace, navigation d'année.

### Écarts avec le PRD et les maquettes, assumés

| Source | Formulation | Choix de la story |
| --- | --- | --- |
| E-03 (fiche) | « tags « Férié FR » / « Férié TN » » dans la liste | plus de badge sur iPhone ; sous-ligne « Jour férié en France » (clé commune, le PC la reçoit aussi : « Jour férié · France » → « Jour férié en France ») ; les bandeaux d'Aujourd'hui et de la Semaine gardent leur étiquette (hors périmètre) |
| Maquette | compte à rebours « dans 40 j » | « J-40 » conservé : forme du PRD E-04, partagée avec l'agenda d'Aujourd'hui et la Semaine (`countdownText`) ; à revoir dans la refonte PC si Ali le veut |
| Maquette | « Masquer les fériés » | **Révisé le 2026-10-28 (PRD-02, lot F, réserve d'Ali ; UI-FIX-08)** : le choix est mémorisé par appareil (réglage local `events.hideHolidays`). Avant UI-FIX-08 : pastille d'affichage, mémorisée le temps de la session (état de l'écran), pas un réglage : les calendriers se règlent dans Réglages (E-03 critère 3) |
| Maquette | « Vue calendrier » | remplace « Calendrier » (le titre de la feuille reste « Calendrier ») |

À ajouter à PRD-02 : E-03 (sous-ligne des fériés, pastille d'affichage).

### Critères

1. **En-tête** (iPhone) : titre « Événements » et navigation d'année (flèches, année) inchangés ; plus de filet décoratif ; pastilles Tout / Pro / Perso puis, à droite, la pastille `.ct-events__holidaysToggle` « Masquer les fériés » (`aria-pressed`), « Afficher les fériés » une fois les fériés masqués ; absente quand aucun calendrier de fériés n'est activé.
2. **Lignes** : jour férié → `data-source="holiday"` grisé (titre et jour en gris `--ct-color-agenda-hour`), sous-ligne « Jour férié en France » / « Jour férié en Tunisie » (+ « · date estimée »), **aucune étiquette** ; événement local ou externe → encre pleine, sous-ligne et compte à rebours inchangés (« J-40 », « Aujourd’hui », anniversaire) ; passé grisé inchangé ; ouverture des fiches inchangée.
3. **Masquer les fériés** : les lignes de fériés et les mois qui n'en ont que disparaissent ; l'état vide ne se déclenche pas pour cette raison seule (une liste sans aucun événement propre garde le message « Aucun événement en 2026 » si les fériés sont masqués et qu'il n'y a rien d'autre : voulu).
4. **Bas de l'écran** : rangée collée au bas, filet au-dessus : « Vue calendrier » (ouvre la feuille « Calendrier », inchangée) et « Événement » (`.ct-events__addButton`, « + », libellé accessible « Ajouter un événement », ouvre la feuille Ajout au segment Événement) ; `.ct-fab` absent.
5. **Sombre**, **largeur**, **zone de sécurité** : jetons existants ; rien de plus large que l'écran ; rangée du bas au-dessus de `--ct-safe-area-bottom`.
6. **Bundle** : écran à la demande ; textes nouveaux (« Masquer les fériés », « Afficher les fériés », « Vue calendrier », « Événement ») dans `src/i18n/eventsRefonteText.ts` ; `events.holidaySubtitle` change de valeur dans le départ à taille égale ; aucun module nouveau dans `start-modules.json`.
7. **PC** : aucune différence hors la sous-ligne des fériés.

### Preuves attendues

- **Rouge d'abord** : `src/features/events/EventsRefonte.test.tsx` (en-tête sans filet et pastille des fériés, lignes de fériés sans étiquette et en toutes lettres, événement propre avec son compte à rebours, masquage, rangée du bas, PC inchangé) ; e2e `tests/e2e/UI-REFONTE-07.spec.ts` sur `iphone` et `iphone-webkit`.
- **Vert ensuite** : suites `events` avec adaptations tracées (`EventsHolidays.test` : sous-ligne et étiquettes ; `EventsScreen.test` : « Vue calendrier ») ; e2e `E-01` (« Vue calendrier »), `E-03` (sous-ligne, étiquettes), `capture.spec` (maquette `Evenements-v2.html`) ; lint ; typage ; garde du bundle ; CI complète.

### Hors périmètre

Les deux autres refontes ; le PRD ; le volet PC ; les bandeaux d'Aujourd'hui et de la Semaine ; la forme « J-12 ».

## Passe agent du module

- **Preuve rouge** : commit 04c8baab (tests seuls) : `src/features/events/EventsRefonte.test.tsx` (6 tests, 5 rouges ; le test « sans calendrier de fériés » est vert dès le départ, attendu), `tests/e2e/UI-REFONTE-07.spec.ts` (3 tests, joués par la CI seule).
- **Catalogue à la demande** `src/i18n/eventsRefonteText.ts` : « Masquer les fériés », « Afficher les fériés », « Vue calendrier », « Événement ». Dans le départ, `events.holidaySubtitle` devient « Jour férié en {country} » (`en` : « Public holiday in {country} »), pour les deux mises en page.
- **Écran** (`EventsScreen.tsx`) : état `hideHolidays` (session de l'écran, jamais écrit) ; `entries` filtrées des fériés sur iPhone quand il est actif (les mois sans ligne disparaissent avec `groupByMonth`, l'état vide suit) ; filet décoratif sur PC seulement ; rangée `.ct-events__pillsRow` : pastilles d'espace puis `.ct-events__holidaysToggle` (iPhone, calendriers activés, hors filtre projet) ; `tag` nul pour un férié sur iPhone ; rangée du bas iPhone : « Vue calendrier » (même feuille « Calendrier ») et `.ct-events__addButton` « Événement » (`Plus`, libellé accessible « Ajouter un événement », même `openAdd`) ; PC garde son bouton flottant « Ajouter ».
- **Feuille de style** (`EventsScreen.css`) : pastille des fériés, fériés grisés (`--ct-color-agenda-hour` / `-past`) sur iPhone, rangée du bas collante au-dessus de `--ct-safe-area-bottom`, « Vue calendrier » au trait prenant la largeur, bouton « Événement » plein ; jetons existants, aucune paire de contraste nouvelle.
- **Tests adaptés, avec trace « UI-REFONTE-07 »** : `EventsHolidays.test` (sous-ligne en toutes lettres, plus de badge dans la liste iPhone ; les bandeaux d'Aujourd'hui gardent « Férié FR »), `EventsCountdown.test` (férié sans étiquette), `EventsScreen.test` (« Vue calendrier ») ; e2e `E-01` (« Vue calendrier »), `E-03` (sous-ligne ; badges sur PC seulement), `capture.spec` (maquette `Evenements-v2.html`).
- **Vérifié en local** : typage, lint, suites Vitest `events` (89 tests), garde du bundle 66/66 (depuis un worktree complet).

## Mesure du bundle

Avant push (commit 67af8e20, build `--manifest`, `node tests/bundle/measureStart.ts`) : **337 592 octets normalisés** (brute 337 566), **marge 20 808** ; **+6** face à `main` 337 586 (la nouvelle valeur de `holidaySubtitle`) ; l'écran et son catalogue sont à la demande. Mesure de `main` après fusion (#105, e9d094b4) : **337 464 octets normalisés**, marge 20 936.

## Passe QA

- **CI, premier passage (run 40715955055, head bdbc5368)** : 44 contrôles verts, `e2e iphone (1/4)` rouge : `E-01` (2 tests), `E-02` (2), `E-04` (1) attendaient le bouton flottant `.ct-fab` « Ajouter un événement » par `tests/e2e/helpers/events.ts` (`addEventButton`), supprimé sur iPhone par la refonte (critère 6). Cause : l'aide n'avait pas été adaptée, seule `E-01` l'était pour « Vue calendrier ». Correction : sur `iphone`, `addEventButton` vise `.ct-events__addButton` (libellé accessible inchangé « Ajouter un événement ») ; sur `pc`, le bouton flottant « Ajouter » reste. Aucun test désactivé ni allongé.
- **CI, second passage** (head 9d4cb544) : 46 verts puis `cargo test (Windows)` annulé par le runner (35 min) et relancé : 48 verts ; branche mise à jour sur `main` (e104924a) : 48 verts. Fusionnée (#105, e9d094b4).

## Passe code-reviewer

Relecture à froid du diff `04c8baab..67af8e20` (écran, catalogue, textes, feuille de style, tests) avant le premier passage en CI.

- **Vérifié sans remarque** : le filtre des fériés n'agit que sur iPhone et ne touche ni `holidays` (toujours chargés : le volet PC, la grille et les points restent justes) ni les réglages ; `dots` de la grille du mois se calcule sur `entries` (filtrées) : fériés masqués = points de fériés masqués dans la feuille « Calendrier », cohérent ; `firstUpcomingEntry` à l'ouverture lit aussi `entries`, l'état initial n'est pas filtré ; la pastille n'apparaît ni sans calendrier activé ni sous un filtre projet (où la liste est vide par règle E-01 critère 10) ; `tag` nul seulement pour un férié sur iPhone (les comptes à rebours des événements propres et externes restent) ; libellés accessibles inchangés (« Ajouter un événement », « Calendrier » pour la feuille) ; aucun texte en dur hors catalogue ; PC : seul `holidaySubtitle` change.
- **Point d'attention laissé à la QA** : « Masquer les fériés » + aucun événement propre → état vide « Aucun événement en 2026 » avec le bouton d'ajout, alors que des fériés existent (voulu, critère 3) ; la pastille reste visible pour les remontrer.
- **Point d'attention appareil** : rangée du bas collante au-dessus de la zone de sécurité ; lisibilité des fériés en gris sur le thème sombre (`--ct-color-agenda-hour` déjà validé par le contraste de l'agenda).

Verdict : approuvée sous réserve de la CI complète (QA à consigner).
