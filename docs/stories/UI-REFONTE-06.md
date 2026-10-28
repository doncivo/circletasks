# UI-REFONTE-06 — Checklists sur iPhone : le sélecteur est le titre, un seul moyen d'ajouter, des libellés qui portent le compte

Module : M6 Checklists · Palier : refontes après la 1.0.2, cinquième des huit dans l'ordre d'Ali du 2026-10-27 · Agent : checklists-events avec ui-design-system · Ouverte le 2026-10-28 par Claude Code.

Statut : **ouverte, passe product-owner écrite.** Estimation : 4 à 6 h actives ; alerte à 9 h.

Références : `docs/maquettes-refonte/Checklists-v2.html`, huit règles transversales du README du même dossier. Écran de départ : `src/features/checklists/ChecklistsScreen.tsx`, `ChecklistDetail.tsx`, `ChecklistProgressBar.tsx`, `AddItemField.tsx`, `Checklists.css`, `src/ui/DropdownSelect.tsx`, textes `src/i18n/fr.checklists.ts` / `en.checklists.ts`. Écran à la demande (`lazyScreens.tsx`). **Périmètre : la mise en page iPhone** (`useLayout() === 'mobile'`) ; le volet PC (PC-Checklists.html) ne change pas.

## Passe product-owner

### Ce que la maquette change (et ce qu'elle ne change pas)

Le nom de la checklist n'apparaît qu'une fois : **le sélecteur est le titre** (Fraunces 36 px avec son chevron ; le `<select>` natif reste dessous, « Choisir une checklist »). L'en-tête du détail (icône, titre répété, bascule « Vue compacte », crayon) disparaît : le crayon « Modifier la checklist » et le « + » « Nouvelle checklist » rejoignent la rangée du titre, « Réorganiser » / « Terminer » rejoint la rangée de progression. La progression devient une barre fine de 6 px et « 2 sur 3 ». Les éléments gardent leur case ronde et leur texte ; les cochés restent à leur place, barrés. **Un seul moyen d'ajouter** : le champ « Ajouter un élément » (pleine largeur, arrondi) ; plus de bouton flottant. En bas, deux libellés sans ambiguïté : « Supprimer les 2 éléments cochés » (le compte dedans, rouge seulement quand il y a de quoi) et « Tout décocher » (réversible, en encre). Rien n'est retiré : création, modification (feuille avec date, modèle, suppression), duplication (C-04), planification (C-03), effacement confirmé et annulable, tout décocher, réorganiser (C-05), filtre d'espace, état vide.

### Écarts avec le PRD et les maquettes, assumés

| Source | Formulation | Choix de la story |
| --- | --- | --- |
| C-02 | « Progression « 3/5 » » | « 2 sur 3 » sur iPhone (même libellé accessible « Progression : 2 sur 3 ») ; PC inchangé (« 3 / 6 ») |
| C-05 | « Bouton « Effacer les cochés » » | « Supprimer les 2 éléments cochés » sur iPhone (« Supprimer l’élément coché », « Supprimer les éléments cochés » à zéro, inactif) ; la boîte de confirmation (« Effacer 2 éléments cochés ? ») et le PC gardent « Effacer » : la boîte redit le compte, le mot change avec la refonte PC |
| A-06 | « Vue compacte » sur chaque liste | retirée de l'écran iPhone (la maquette n'en a pas) ; le réglage reste pour le PC |
| Maquette | aucun moyen visible de créer une checklist ni de la modifier | « + » (« Nouvelle checklist ») et crayon (« Modifier la checklist ») en boutons d'icône à droite du titre, « Réorganiser » à droite de la progression : chaque commande une fois, rien de retiré |

À ajouter à PRD-02 : C-02 (forme de la progression), C-05 (verbe « Supprimer » et compte), A-06 (Checklists iPhone).

### Critères

1. **Rangée du titre** (iPhone) : `DropdownSelect` dont le texte visible est un `h1` (Fraunces 36 px) suivi du chevron, `<select>` natif « Choisir une checklist » conservé ; à droite, bouton d'icône « Nouvelle checklist » (`Plus`) et bouton d'icône « Modifier la checklist » (`Pencil`). Sans checklist : `h1` « Checklists » et le bouton « Nouvelle checklist » ; l'état vide inchangé. Une seule occurrence du nom à l'écran.
2. **Détail** (iPhone) : plus d'en-tête de détail (`.ct-checklist-detail__head`), ni de filet décoratif, ni de bascule « Vue compacte » ; rangée de progression : barre 6 px, `role="progressbar"` inchangé, compte « 2 sur 3 » (`role="status"`, libellé accessible « Progression : 2 sur 3 »), puis « Réorganiser » / « Terminer » ; mentions « Perso · modèle réutilisable », « Prévue le … » inchangées sous la barre.
3. **Éléments** : case ronde et texte, cochés barrés à leur place, mode « Réorganiser » (poignées et « − ») inchangé.
4. **Ajout** : un seul champ « Ajouter un élément » (libellé « Nouvel élément »), pleine largeur, arrondi, Entrée enchaîne ; plus de bouton flottant (`.ct-fab` absent).
5. **Bas de l'écran** : rangée collée au bas, filet au-dessus : « Supprimer les 2 éléments cochés » (`data-variant="danger"`, confirmation et annulation inchangées) et « Tout décocher » ; à zéro coché : « Supprimer les éléments cochés » et « Tout décocher » inactifs (`aria-disabled`).
6. **Sombre** et **largeur** : jetons existants ; rien de plus large que l'écran (`expectFitsViewport`) ; rangée du bas au-dessus de `--ct-safe-area-bottom`.
7. **Bundle** : écran à la demande ; textes nouveaux (« 2 sur 3 », « Supprimer les … ») dans `src/i18n/checklistsRefonteText.ts` ; `DropdownSelect` reçoit une propriété `textAs` (quelques octets dans le départ, mesurés) ; aucun module nouveau dans `start-modules.json`.
8. **PC** : aucune différence.

### Preuves attendues

- **Rouge d'abord** : `src/features/checklists/ChecklistsRefonte.test.tsx` (titre-sélecteur unique, boutons d'icône, progression « 2 sur 3 » et « Réorganiser » dans sa rangée, libellés du bas avec le compte et leurs états, ajout par le champ seul, PC inchangé) ; e2e `tests/e2e/UI-REFONTE-06.spec.ts` sur `iphone` et `iphone-webkit`.
- **Vert ensuite** : suites `checklists` avec adaptations tracées (`ChecklistsBatch`, `ChecklistsCheck`, `ChecklistsQa`, `ChecklistsCreate`, `ChecklistsPlan` : « 3 sur 6 », « Supprimer les 3 éléments cochés », bascule absente) ; e2e `C-01` à `C-05`, `helpers/checklists.ts`, `capture.spec` (maquette `Checklists-v2.html`) ; lint ; typage ; garde du bundle ; CI complète.

### Hors périmètre

Les trois autres refontes ; le PRD ; le volet PC ; la feuille « Modifier la checklist ».

## Passe agent du module

- **Preuve rouge** : commit f02e0b35 (tests seuls) : `src/features/checklists/ChecklistsRefonte.test.tsx` (7 tests, 6 rouges ; le test « PC inchangé » est vert dès le départ, attendu), `tests/e2e/UI-REFONTE-06.spec.ts` (3 tests, joués par la CI seule). Trois attentes corrigées avant le vert, sans toucher au code : le bandeau « Annuler » est aussi un `role="status"`, la progression se lit dans `.ct-checklist-progress`.
- **Catalogue à la demande** `src/i18n/checklistsRefonteText.ts` : « {checked} sur {total} », `clearCheckedLabel` (« Supprimer les 2 éléments cochés », « Supprimer l’élément coché », « Supprimer les éléments cochés » à zéro). Aucune clé du départ ne change ; `DropdownSelect` (départ) reçoit `textAs?: 'span' | 'h1'` (+18 octets mesurés).
- **Rangée du titre** (`ChecklistsScreen.tsx`, iPhone) : `DropdownSelect` `textAs="h1"` avec la classe `ct-checklists__chooser--title` (Fraunces 36 px, chevron, sans cadre ; le `<select>` natif « Choisir une checklist » recouvre toujours le bouton) ; à droite, `.ct-checklists__topActions` : « Nouvelle checklist » (`Plus`, masqué sous un filtre de projet comme l'état vide) et « Modifier la checklist » (`Pencil`, même ouverture de la feuille) ; le bouton flottant et la rangée du bas disparaissent ; sans checklist, `h1` « Checklists » et le « + ».
- **Détail** (`ChecklistDetail.tsx`) : sur iPhone, ni en-tête (icône, titre, bascule, crayon) ni filet ; `ChecklistProgressBar mobile` avec « Réorganiser » / « Terminer » comme `trailing` (`ReactNode` accepté) ; `compact` transmis aux éléments sur PC seulement ; libellé du bas par `clearCheckedLabel(progress.checked)` sur iPhone, « Effacer les cochés » sur PC ; confirmation, annulation, focus et « Tout décocher » inchangés.
- **Progression** (`ChecklistProgressBar.tsx`) : `data-layout="mobile"`, texte « 2 sur 3 » (libellé accessible « Progression : 2 sur 3 » inchangé), barre et remplissage de 6 px en encre ; PC inchangé.
- **Feuille de style** (`Checklists.css`) : titre-sélecteur, actions du haut, progression fine, éléments en lignes sans carte, champ d'ajout arrondi au trait plein, rangée du bas collante au-dessus de `--ct-safe-area-bottom` avec deux libellés texte (rouge seulement quand il y a de quoi) ; jetons existants, aucune paire de contraste nouvelle.
- **Tests adaptés, avec trace « UI-REFONTE-06 »** : DOM à 440 : « 3 sur 6 » (`ChecklistsBatch`, `ChecklistsCheck`, `ChecklistsQa`, `ChecklistsTemplate`), bouton « Supprimer … cochés » (`ChecklistsBatch`, `ChecklistsQa`), vue compacte jouée à 1440 (`ChecklistsCheck`) ; e2e : aides `progressText` et `clearCheckedButton` dans `helpers/checklists.ts`, `C-02` à `C-05` (progression par mise en page, bouton du bas, « Vue compacte » PC seulement), `capture.spec` (maquette `Checklists-v2.html`).
- **Vérifié en local** : typage, lint, suites Vitest `checklists` (98 tests), garde du bundle 66/66 (depuis un worktree complet).

## Mesure du bundle

Avant push (commit 17e087f8, build `--manifest`, `node tests/bundle/measureStart.ts`) : **337 604 octets normalisés** (brute 337 589), **marge 20 796** ; **+18** face à `main` 337 586 : la propriété `textAs` de `DropdownSelect` (départ) ; l'écran et son catalogue sont à la demande. Mesure de `main` après fusion (#104, c5a8ac20) : **337 604 octets normalisés**, marge 20 796.

## Passe QA

- **CI complète** verte (48 contrôles). Fusionnée (#104, c5a8ac20).

## Passe code-reviewer

Relecture à froid du diff `f02e0b35..17e087f8` (écran, détail, progression, `DropdownSelect`, catalogue, feuilles de style, tests) avant le premier passage en CI.

- **Vérifié sans remarque** : le nom accessible du `h1` est le seul titre (le `<select>` est un frère, pas un enfant : son option choisie n'entre pas dans le nom du titre ; l'aide e2e `chooseChecklist` attend ce `h1`) ; « Modifier la checklist » et « Nouvelle checklist » gardent leurs libellés et leurs effets (`setEditor('edit')`, `openCreate`) ; « Réorganiser » garde `aria-pressed` et `onReorderingChange` (le changement de checklist le quitte toujours, l'état vit dans l'écran) ; la confirmation d'effacement, la restitution du focus et « Tout décocher » sont textuellement inchangés ; le PC garde en-tête, filet, bascule, « 3 / 6 », « Effacer les cochés » et son bouton flottant ; `compact` n'est plus appliqué aux éléments sur iPhone sans être écrit ; `ChecklistProgressBar` accepte un `ReactNode` en `trailing` et n'en rend rien quand il est vide ; `clearCheckedLabel` ne change pas le `data-variant="danger"` ni `aria-disabled` à zéro (le gris vient de la feuille de style) ; aucun texte en dur hors catalogue.
- **Point d'attention laissé à la QA** : un titre très long en Fraunces 36 px passe à la ligne (`overflow-wrap: anywhere`) et pousse les deux boutons d'icône vers le haut (`align-items: flex-start`) : voulu ; à voir sur l'appareil avec « Choisir une checklist » (roue iOS).
- **Point d'attention appareil** : rangée du bas collante au-dessus de la zone de sécurité, clavier ouvert sur le champ d'ajout.

Verdict : approuvée sous réserve de la CI complète (QA à consigner).
