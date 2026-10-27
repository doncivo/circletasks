# UI-REFONTE-03 — Semaine sur iPhone : heures en colonne, aujourd'hui au trait d'encre, synthèse de la semaine

Module : M3 Semaine · Palier : refontes après la 1.0.2, deuxième des huit dans l'ordre d'Ali du 2026-10-27 · Agent : tasks-planning avec ui-design-system · Ouverte le 2026-10-27 par Claude Code.

Statut : **ouverte, passe product-owner écrite ; aucun code.** Estimation : 8 à 12 h actives ; alerte à 15 h (Ali prévenu si l'estimation dérape de plus de 50 %).

Références : `docs/maquettes-refonte/Semaine-v2.html`, PR #84 (962893b1), huit règles transversales du README du même dossier. Écran de départ : `src/features/week/` (`WeekScreen.tsx`, `WeekHeader.tsx`, `WeekDayView.tsx`, `WeekItems.tsx`, `WeekDayAdd.tsx`, `useWeekMoves.tsx`, `WeekScreen.css`, `weekStore.ts`), domaine `src/domain/week.ts` et `todayList.ts`. Acquis de UI-REFONTE-02 (PR #99) à réutiliser : jetons `--ct-color-agenda-hour`, `-past`, `-late`, `-event`, `formatLate`, `lateMinutes`, et le gabarit visuel de la colonne d'heures.

## Passe product-owner

### Ce que la maquette change (et ce qu'elle ne change pas)

Sur iPhone, la Semaine garde ses sept sections empilées mais les aligne sur la grammaire de l'agenda du jour : heures alignées en colonne (ou tiret), case à cocher puis titre, rond au trait pour les événements, faits barrés. Aujourd'hui est marqué par un **trait d'encre** en haut de sa section et un jour en gras, plus par un fond gris. Les jours s'écrivent en minuscules (« lun. »), le week-end recule en gris. Une **ligne de synthèse** sous le titre dit la semaine en trois nombres : restantes, faites, en retard. Le champ d'ajout quitte chaque section pour une seule rangée en bas, « Ajouter à jeudi 24 », qui vise le jour sélectionné, à côté du « + ». **Périmètre : la mise en page iPhone (`useLayout() === 'mobile'`)** ; les sept colonnes du PC ne changent pas. Aucune fonction retirée : balayage entre semaines (S-03), glisser-déposer (S-02), gestes de ligne (A-07), fiche d'événement externe, « Planifier » depuis Un jour (S-06, dans l'écran Un jour), checklists du jour (C-03), filtre Pro / Perso / Tout (ES-03) sont conservés tels quels.

### Écarts avec le PRD, à trancher par Ali (à ajouter à la ligne PRD-02 proposée par UI-REFONTE-02)

| PRD | Formulation actuelle | Maquette | Choix de la story |
| --- | --- | --- | --- |
| S-04 | « Champ d'ajout rapide en bas de chaque jour » | une seule rangée d'ajout en bas, « Ajouter à jeudi 24 » | sur iPhone, un champ unique visant le **jour sélectionné** (aujourd'hui par défaut, un toucher sur l'en-tête d'un jour le sélectionne) ; PC inchangé (champ par colonne) |
| S-01 | « jour courant mis en évidence » | trait d'encre et jour en gras, pas de fond | la mise en évidence reste, sa forme change |
| S-03 | « retour « Cette semaine » » | absent de la maquette | la pastille « Cette semaine » reste, affichée seulement hors de la semaine courante (règle 3 : aucune commande qui ne peut rien faire) |

### Critères

1. **En-tête.** Au-dessus du titre : « semaine 39 » en petit gris, minuscule initiale, sans l'année (l'année apparaît seulement si la semaine n'est pas dans l'année courante : « semaine 1 · 2027 ») ; titre « 21 – 27 sept. » en Fraunces (44 px, ajusté par `useFitText` comme aujourd'hui) ; à droite, « Semaine précédente » et « Semaine suivante » ; plus de filet décoratif.
2. **Synthèse.** Une ligne sous le titre, séparée par un filet : « 8 tâches restantes · 6 faites · 1 en retard » (singulier « 1 tâche restante », « 1 faite »), comptée sur les sept jours affichés et le filtre courant, tâches seulement (ni routines, ni événements, ni checklists) ; « en retard » = tâches non faites d'un jour passé de la semaine affichée, plus, le jour courant, celles dont l'heure est dépassée ; segment « en retard » en rouge (`--ct-color-agenda-late`) et **absent à zéro** ; semaine sans tâche : « Rien de prévu cette semaine » à la place des trois nombres. Fonction pure `weekSummary` dans `src/domain/weekSummary.ts` (module à la demande, chargé avec l'écran), textes dans `src/i18n`.
3. **Filtres.** Tout / Pro / Perso en pastilles (comme UI-REFONTE-02) ; « Cette semaine » à droite, seulement hors de la semaine courante.
4. **Sections de jour.** Colonne de gauche de 48 px : jour court en minuscules (« lun. ») et numéro ; **aujourd'hui** : trait d'encre de 2 px en haut de la section, jour et numéro en encre et en gras, `aria-current="date"` conservé, aucun fond ; jours passés : numéro atténué (`--ct-color-agenda-past`) ; samedi et dimanche : jour et numéro en gris (`--ct-color-agenda-hour`) ; séparation fine entre les sections. Un toucher sur la colonne de gauche sélectionne le jour pour la rangée d'ajout (critère 7) ; le jour sélectionné porte `aria-pressed`.
5. **Lignes.** Dans chaque section : heure dans une colonne alignée (46 px, chiffres tabulaires) ou tiret « — » sans heure ; case à cocher (20 px, coins arrondis, celle d'aujourd'hui) puis titre ; routine : même ligne (case seulement si validable, inactive les jours futurs) ; événement : rond au trait de la couleur des événements (anniversaire et férié : leurs couleurs), titre, ouvre la fiche comme aujourd'hui ; checklist : tiret, icône, titre, « 3/5 ». Ordre dans un jour : à l'heure par heure (événements, routines, tâches dans l'ordre manuel, `compareTodayRows`), puis sans heure, **faits à leur heure** (barrés et atténués) ; le jour courant, une tâche non faite dont l'heure est dépassée porte l'heure en rouge et la mention « en retard » (sans durée, comme la maquette). Plus d'icône décorative ni de marque d'objectif en ligne (la fiche les garde).
6. **Jour vide** : « Rien de prévu » en gris dans la section ; la semaine entièrement vide garde son état vide actuel (`empty.weekTitle`) et la rangée d'ajout.
7. **Ajout.** Rangée en bas, au-dessus de la zone de sécurité : champ « Ajouter à jeudi 24 » (jour sélectionné, `formatDropDayLabel`), même saisie rapide Q-01 / Q-06 que `WeekDayAdd` (aperçu, suggestions), créée dans le jour sélectionné ; bouton « + » plein ouvrant la feuille « Nouvelle tâche » datée du jour sélectionné. Les boutons « + Ajouter » par section disparaissent sur iPhone (S-04 ci-dessus). `aria-label` « Ajouter » conservé pour le « + ».
8. **Gestes et déplacements inchangés** : balayage horizontal entre semaines avec son annonce, glisser-déposer d'une ligne vers un autre jour (zones `.ct-week__dropHere`, défilement automatique), gestes de ligne (terminer, reporter, Un jour, supprimer), appui long vers la fiche.
9. **Sombre** : jetons existants et ceux de UI-REFONTE-02 ; les paires nouvelles passent `contrastCss.test.ts`.
10. **Zone de sécurité iOS** : en-tête sous `--ct-safe-area-top`, rangée d'ajout au-dessus de `--ct-safe-area-bottom`, clavier ouvert compris.
11. **Bundle de départ** : l'écran Semaine est déjà un bloc à la demande ; `weekSummary.ts` et tout texte nouveau propre à la Semaine restent hors du départ (catalogue chargé avec l'écran si les clés sortent du bloc `week` de `fr.ts` ; sinon, hausse de `fr.ts` justifiée au kilo-octet près) ; aucun module nouveau dans `start-modules.json` sans justification ; mesure avant push et sur `main` après fusion, plafond inchangé.
12. **PC** : aucune différence de rendu ni de test.

### Preuves attendues

- **Rouge d'abord** (commit de tests seuls) : `src/domain/weekSummary.test.ts` (comptes, singulier/pluriel, en retard jour passé et jour courant à l'heure dépassée, filtre, semaine vide) ; `src/features/week/WeekRefonte.test.tsx` (en-tête « semaine 39 » sans année, ligne de synthèse, jours en minuscules, trait d'aujourd'hui sans fond, week-end gris, colonne d'heures et tiret, rond d'événement, « Rien de prévu », jour sélectionné et champ « Ajouter à jeu. 24 », plus de bouton par section, PC inchangé) ; e2e `tests/e2e/UI-REFONTE-03.spec.ts` sur `iphone` et `iphone-webkit` (en-tête, synthèse, aujourd'hui au trait, sélection d'un jour et ajout, balayage conservé, thème sombre, zone de sécurité).
- **Vert ensuite** : suites `week`, `domain/week`, `goals/GoalAttach`, `spaces/ProjectFilter`, `theme` ; adaptations tracées des tests qui lisent « Semaine 40 · 2026 », « LUN. », `.ct-week-item__time` ou « + Ajouter » par section sur iPhone (`WeekScreen.test`, `WeekNavigation.test`, `WeekQuickAdd.test`, `WeekQa.test`, e2e S-01, S-04, IOS-titres, `tests/visual/capture.spec.ts`) ; lint ; typage ; bundle 64/64 ; CI complète.

### Hors périmètre

Les six autres refontes ; le PRD (PRD-02) ; toute écriture en base ; le rendu natif (séance d'Ali).

## Passe agent du module

À écrire après la preuve rouge.

## Passe QA

À écrire.

## Passe code-reviewer

À écrire.
