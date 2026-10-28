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
| Maquette | « Masquer les fériés » | pastille d'affichage, mémorisée le temps de la session (état de l'écran), pas un réglage : les calendriers se règlent dans Réglages (E-03 critère 3) |
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

À écrire après la preuve rouge.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

À écrire.
