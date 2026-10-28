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

À écrire après la preuve rouge.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

À écrire.
