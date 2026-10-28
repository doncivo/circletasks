# UI-REFONTE-08 — Aujourd'hui sur PC : barre fixe nommée, colonne du jour bornée, seconde colonne « ce qui arrive »

Module : M2 Aujourd'hui · Palier : refontes après la 1.0.2, septième des huit dans l'ordre d'Ali du 2026-10-27 · Agent : tasks-planning avec ui-design-system · Ouverte le 2026-10-28 par Claude Code.

Statut : **ouverte, passe product-owner écrite.** Estimation : 8 à 12 h actives ; alerte à 15 h.

Références : `docs/maquettes-refonte/PC-Jour.html`, huit règles transversales du README du même dossier ; acquis de UI-REFONTE-02 (agenda du jour, `buildTodayAgenda`, `TodayGoalLine`, jetons `--ct-color-agenda-*`). Écran de départ : `src/features/today/TodayScreen.tsx`, `TodayHeader.tsx`, `TodayListView.tsx`, `TodayParts.tsx`, `TodayCreate.tsx`, `TodayScreen.css` ; `src/features/search/SearchButton.tsx`, `src/features/someday/SomedayButton.tsx`. Aujourd'hui est l'écran du premier rendu : **tout ce qui s'ajoute au départ se mesure** ; la seconde colonne est un bloc à la demande. **Périmètre : la mise en page PC** (`useLayout() === 'pc'`) ; l'agenda iPhone (UI-REFONTE-02) ne change pas.

## Passe product-owner

### Ce que la maquette change (et ce qu'elle ne change pas)

Le PC cesse d'étirer la mise en page du téléphone (règle 7 : on borne et on navigue). **Une barre fixe** en haut de l'écran porte les pastilles Tout / Pro / Perso, le champ « Rechercher  Ctrl K », puis des **boutons nommés** : « Objectif », « Rapport », « Un jour » (les icônes portent leur nom), suivis de « Ajouter » (la feuille « Nouvelle tâche », qui remplace le bouton flottant), « Édition » et « Compacte » (les deux bascules A-05 / A-06, nommées elles aussi). Dessous, **deux colonnes** : à gauche, **la colonne du jour, bornée à 660 px** : « octobre 2026 » en petit, « samedi 24 » en Fraunces 44 px, flèches « Jour précédent / suivant » à droite, plus de badge « AUJOURD'HUI » ni de filet décoratif ; la ligne d'objectif (« Objectif · titre · 2/5 », comme sur iPhone) ; **l'agenda du jour** (colonne d'heures, passé qui recule, dû en gros, ligne « maintenant », tiret pour les sans heure, événements en rond au trait : le même `buildTodayAgenda` que l'iPhone, en remplacement de la liste à cartes, des bandeaux d'événements et de l'encadré d'objectif) ; les checklists du jour ; en bas, le champ « Ajouter une tâche — ex. « Appeler Paul demain 10h » » avec son champ « Date » (T-14) et « Scanner ». À droite, **la seconde colonne** (420 px au plus, filet à gauche) : « Demain » (lignes heure ou tiret + titre), « Cette semaine » (jours restants de la semaine : jour court + titre, compte à rebours des événements), « Raccourcis » (Ctrl N nouvelle tâche, Ctrl K rechercher, Ctrl / tous les raccourcis) ; elle remplace l'aide clavier du bas. Rien n'est retiré : mode édition, vue compacte, glisser-déposer (A-02), raccourcis clavier (D-04), fiche détail à droite (A-08), flèches de jour (Q10), filtres, « Un jour », objectif, rapport, recherche.

### Écarts avec le PRD et les maquettes, assumés

| Source | Formulation | Choix de la story |
| --- | --- | --- |
| A-01 | badge « AUJOURD'HUI » sur le jour courant (PC) | retiré sur PC comme sur iPhone (UI-REFONTE-02) ; la ligne « maintenant » et `data-today` disent le jour courant ; e2e A-01 adapté |
| A-05 | « Interrupteur « − » en bas à gauche » (PC) | bascule nommée « Édition » dans la barre fixe (libellé accessible « Mode édition » conservé) |
| A-06 | « Icône à deux flèches à droite de la date » | bascule nommée « Compacte » dans la barre fixe (libellé « Vue compacte » conservé) |
| Maquette | bouton flottant retiré, rien à sa place | « Ajouter » nommé dans la barre fixe (feuille « Nouvelle tâche », Ctrl N inchangé) : la feuille reste le seul accès aux options de création, la saisie en ligne reste le geste rapide |
| Maquette | « dans 40 j » dans « Cette semaine » | « J-40 » (forme du PRD E-04, partagée) |
| PC-Aujourdhui.html (septembre) | liste à cartes, bandeaux, encadré d'objectif | remplacés par l'agenda du jour, les lignes d'événements et la ligne d'objectif de UI-REFONTE-02 : une seule grammaire du jour sur les deux plateformes |

À ajouter à PRD-02 : A-01 (badge PC), A-05 et A-06 (bascules nommées dans la barre), T-14 inchangé.

### Critères

1. **Barre fixe** `.ct-today__topbar` (PC) : pastilles d'espace, champ « Rechercher  Ctrl K » (bouton existant), puis « Objectif » (`Target`, libellé accessible « Objectif de la semaine »), « Rapport » (`ChartColumn`, « Rapport mensuel »), « Un jour » (icône horloge, libellé « Un jour, 6 tâches » et badge conservés), « Ajouter » (`Plus`, ouvre la feuille « Nouvelle tâche »), « Édition » (bascule, `aria-pressed`, libellé « Mode édition »), « Compacte » (bascule, libellé « Vue compacte ») ; filet dessous ; plus de rangée d'icônes muettes ni de bouton flottant ni de rangée du bas avec l'aide clavier.
2. **Colonne du jour** `.ct-today__dayColumn` : largeur 660 px ; en-tête : mois et année en petit, jour en Fraunces 44 px (`h1.ct-today__day`), flèches de jour à droite ; plus de badge ni de filet décoratif ; ligne d'objectif `.ct-agenda-goal` (OB-01, OB-02) ; **agenda du jour** (`.ct-today__list--agenda`, `.ct-agenda__line[data-phase]`, `.ct-agenda__now` le jour courant, dû en gros, tiret sans heure, événements `.ct-agenda__eventMark`), édition (poignées, sélection, barre d'actions) et vue compacte opérantes dans l'agenda comme sur iPhone ; checklists du jour dessous ; en bas, champ d'ajout avec « Date » (T-14) et « Scanner » (Q-04) ; les propositions OB-05 restent en tête.
3. **Seconde colonne** `.ct-today__side` (bloc à la demande `LazyTodaySide`, 420 px au plus, filet à gauche) : « Demain » (tâches et routines du lendemain : heure ou tiret, titre ; « Rien de prévu » si vide), « Cette semaine » (jours après demain jusqu'au dimanche : jour court, titre, compte à rebours des événements importants ; « Rien de prévu » si vide), « Raccourcis » (Ctrl N, Ctrl K, Ctrl / avec « tous les raccourcis » qui ouvre l'aide) ; relue au changement de filtre, de jour et aux changements des sources.
4. **Sombre** : jetons existants (barre et filets `--ct-color-border`, agenda) ; aucune paire nouvelle.
5. **iPhone** : aucune différence de rendu ni de test.
6. **Bundle de départ** : la barre et l'en-tête PC remplacent du code existant ; la seconde colonne et ses textes (« Demain », « Cette semaine », « Raccourcis », « Rien de prévu », boutons nommés) sont dans un catalogue à la demande chargé avec le bloc ; `TodayGoalCard`, `TodayEventBands` et la liste à cartes PC disparaissent du départ ; mesure avant push ; si la hausse dépasse 2 500 octets, arrêt au commit et Ali prévenu (consigne du 2026-10-28).
7. **Tests** : e2e PC existants adaptés avec trace (ordre de l'agenda, lignes d'événements, badge, bascules nommées) sans changer un comportement.

### Preuves attendues

- **Rouge d'abord** : `src/features/today/TodayPc.test.tsx` (barre et ses boutons nommés, colonnes, agenda sur PC avec ligne « maintenant », ligne d'objectif, seconde colonne « Demain » / « Cette semaine » / « Raccourcis », champ d'ajout avec Date et Scanner, ni badge ni bouton flottant ni filet, iPhone inchangé) ; e2e `tests/e2e/UI-REFONTE-08.spec.ts` sur `pc` (clair et sombre).
- **Vert ensuite** : suites `today`, `goals`, `events`, `spaces`, `someday` à 1440 (adaptations tracées) ; e2e PC `A-01` à `A-09`, `OB-0x`, `ES-0x`, `K-03`, `R-02`, `R-03`, `IOS-titres` non concerné, `capture.spec` (maquette `PC-Jour.html`) ; lint ; typage ; garde du bundle ; CI complète.

### Hors périmètre

La dernière refonte (Réglages PC) ; le PRD ; l'agenda iPhone ; la fiche détail ; la feuille « Nouvelle tâche ».

## Passe agent du module

À écrire après la preuve rouge.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

À écrire.
