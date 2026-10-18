# UI-FIX-01 — Thème sombre lisible (bandeau « Annuler », bouton principal des projets, interrupteurs) et test de contraste sur toutes les paires CSS des deux thèmes

Module : M12 Apparence et accessibilité · Ordre de construction : palier 1.0, **étape 6 (B11)** · Agents : **ui-design-system** (jetons, feuilles de style, captures) + **accessibility-i18n** (test de contraste, calcul des seuils, e2e) · Relecture : code-reviewer (après qa-test) · Estimation : **1,5 h de correctif + 3 h de garde-fou = 4,5 h**, **alerte à Ali au-delà de 6,75 h (+50 %)** · Statut : fiche écrite, à développer
Correctif sans équivalent au PRD (P-02 « clair, sombre ou système » est livré ; le PRD section 5, ligne 391, ne donne de couleurs que pour le thème clair : aucun écart, mais les jetons ajoutés sont à noter dans docs/decisions.md). Source : docs/audit-1.0.md, ligne B11. Référence visuelle : maquettes `docs/maquettes/` (ouvrir `index.html` ; absentes de ce worktree au moment de l'écriture, à ouvrir depuis le dépôt principal) ; seule `Main-Sombre.html` est une maquette sombre, `Gestes.html` (bandeau « Annuler ») et `Reglages.html` (`.sw`) sont claires : les valeurs sombres ci-dessous sont dérivées des jetons existants et validées par le test de contraste, puis par la capture.
Dépend de : P-02, A-07 (livrés). Ne touche aucun fichier TypeScript de l'application (seulement CSS, tests et captures).

## Contexte

Constat (lignes vérifiées sur `main` c01e961b) :
- `src/ui/theme/tokens.css` : en clair `--ct-color-nav-bg: #2e2150` (ligne 81) et `--ct-color-accent-on: #ffffff` (ligne 84) ; en sombre `--ct-color-nav-bg: #120e20` (lignes 171 et 221) et `--ct-color-accent-on: #1c1630` (lignes 174 et 224). `accent-on` est conçu pour se poser sur `--ct-color-accent` (en sombre lavande `#c9bee6`), **pas** sur `nav-bg`. Posé sur `nav-bg` en sombre, il donne `#1c1630` sur `#120e20` = **1,09:1**.
- Trois endroits le font : `src/ui/Toast.css:9-10` (`background: var(--ct-color-nav-bg); color: var(--ct-color-accent-on)` : le bandeau « Annuler » qui suit chaque action, plus l'anneau de focus de la ligne **55**, `outline: 2px solid var(--ct-color-accent-on)`), `src/features/spaces/SpacesScreen.css:213-216` (`.ct-projects__button--primary` : fond `nav-bg`, bordure `nav-bg`, texte `accent-on`), et `src/ui/Switch.css:23` et **27** : l'interrupteur « activé » a pour piste `var(--ct-color-nav-bg)` (`#120e20` sur le fond `#1c1630` = 1,09:1, la piste disparaît) et l'interrupteur « désactivé » a pour piste `var(--ct-color-switch-off, #ddd9e4)` : **ce jeton n'est défini nulle part** (seul le repli littéral joue), et le pouce est un `#ffffff` littéral (ligne 35), donc blanc sur gris clair (1,37:1) dans les deux thèmes.
- Même défaut probable, à confirmer par le test : `src/ui/WeekdayToggles.css:24-26` retombe sur `nav-bg` + `accent-on` quand `--ct-routine-done` n'est pas défini (défini dans `src/features/routines/routineTokens.css:7`, donc le repli ne joue que si cette feuille n'est pas chargée). Autres usages de `accent-on` à vérifier : `Button.css:20`, `DateField.css:140,209`, `RecurrencePicker.css:90`, `Checklists.css:658`, `ScanDialog.css:308,411`, `SomedayButton.css:34`.
- Pourquoi non détecté : (1) `src/ui/theme/contrast.test.ts` ne vérifie qu'une **liste fixe** de douze paires de jetons (lignes 45-58) et seulement dans `tokens.css` : aucune règle CSS réelle n'est lue, donc l'usage d'un jeton sur un fond qui n'est pas le sien n'est jamais vu ; (2) jsdom ne charge aucun CSS ; (3) `tests/visual/capture.spec.ts` n'a que deux captures sombres (`Main-Sombre` ligne 407, `Apparence-Sombre` ligne 521), aucune du bandeau « Annuler », des projets ni d'un interrupteur ; `tests/e2e/A-07.spec.ts:195` ne vérifie que les gestes en sombre.

## Bundle de départ

- Plafond **358 400** octets gzip, valeur courante **358 357**, marge **43** (`tests/bundle/startBundle.test.ts`). **Cette mesure ne compte aucune feuille CSS** : le test additionne les seuls fichiers dont le nom se termine par `.js` du graphe statique de `index.html` (`chunks.filter((chunk) => chunk.file.endsWith('.js'))`, ligne 64). Les octets de `tokens.css`, `Toast.css`, `Switch.css` et `SpacesScreen.css` n'y entrent donc pas : l'audit du départ l'estime à **0 octet de JavaScript**.
- **Réserve** : les noms de fichiers CSS (hachés par le contenu) apparaissent dans les tables de préchargement du JavaScript ; modifier une feuille change son hachage, donc quelques octets de la table du bloc principal. Variation attendue : une dizaine d'octets, dans la marge de 43. **Exigence : net <= 0 attendu, mesure après chaque commit** (`npm run test:bundle`) ; si le net dépasse +10 octets ou la marge, arrêt et remontée à Ali (paliers BUNDLE-01). Aucun fichier TypeScript de l'application n'est modifié (les tests et le noyau de test ne sont pas dans le bundle).

## Décisions retenues

1. **Jeton `--ct-color-on-nav`** : blanc `#ffffff` dans les deux thèmes (texte et anneau de focus posés sur `nav-bg`), défini dans `:root` et donc hérité des blocs clair et sombre ; ratio clair 14,6:1, sombre environ 18:1. Remplace `accent-on` aux endroits où le fond est `nav-bg` : `Toast.css:10` et `Toast.css:55`, `SpacesScreen.css:216`, `WeekdayToggles.css:26` (repli). Rendu **clair inchangé** (même blanc sur même violet).
2. **Jetons d'interrupteur** (nouveaux, dans `tokens.css`, clair et sombre explicites) : `--ct-color-switch-on` (piste activée), `--ct-color-switch-on-thumb`, `--ct-color-switch-off` (piste désactivée), `--ct-color-switch-off-thumb`. Valeurs de départ, ajustables tant que les relations du critère 8 passent : **clair** `#2e2150`, `#ffffff`, `#ddd9e4`, `#ffffff` (identique à la maquette `.sw` : aucun changement visuel) ; **sombre** `#c9bee6`, `#1c1630`, `#6d6489`, `#f1eef8` (lavande comme `--ct-edit-track` du commutateur d'édition ; rapports calculés à la main : piste activée sur fond 9,9:1, pouce sur piste activée 9,9:1, piste désactivée sur fond 3,2:1, pouce sur piste désactivée 4,8:1). `Switch.css` ne contient plus aucun littéral de couleur ni de repli.
3. **Exemption documentée en clair** : la piste désactivée de la maquette (`#ddd9e4` sur blanc = 1,37:1) et son pouce blanc (1,37:1) sont sous 3:1. Elles sont conservées (la maquette est la référence visuelle ; l'état se lit aussi à la position du pouce et à l'écart avec la piste activée, 10:1) et inscrites dans une **liste d'exemptions** fermée, avec leur raison. Question 1 à Ali.
4. **Le test parcourt les règles CSS réelles, pas une liste de jetons.** Trois mécanismes : (a) **paires de même règle** : toute règle de `src/**/*.css` qui déclare à la fois une couleur de texte (`color`) et un fond (`background` ou `background-color`) est résolue dans chacun des deux thèmes et doit donner **>= 4,5:1** (WCAG 1.4.3) ; (b) **relations de composants** : liste de relations entre deux règles désignées par **sélecteur** (piste et pouce de l'interrupteur, bouton principal et son anneau de focus, anneau du bandeau) résolues à partir du CSS réel, **>= 3:1** (WCAG 1.4.11) ; (c) **inventaire** : tout jeton de couleur `--ct-*` déclaré dans un fichier CSS doit apparaître dans au moins une paire résolue ou dans la liste fermée des jetons décoratifs (bordures, ombres, pastels d'onglets, avec leur raison), sinon le test échoue : un jeton ajouté demain oblige à décider.
5. **Extraction par analyse statique** : un petit lecteur de CSS dans le noyau de test (commentaires retirés, accolades équilibrées, règles à plat avec leurs `@media` aplaties, sélecteurs séparés par des virgules), sans dépendance ajoutée (si `postcss` figure déjà dans `package.json`, l'utiliser). Résolution : `var(--x)` et `var(--x, repli)` imbriqués, hexadécimal sur 3, 4, 6 et 8 chiffres, `rgb()`/`rgba()` opaques, `transparent` et `currentColor` non résolus. Thème **clair** = `:root` + `:root[data-theme='light']` ; thème **sombre** = `:root` + `:root[data-theme='dark']` (le test existant impose déjà l'égalité avec le bloc `prefers-color-scheme`). Les jetons sont lus dans **tous** les fichiers CSS (au moins `tokens.css`, `routineTokens.css`, `statsTokens.css`), pas seulement `tokens.css`.
6. **Cas non résolus listés, jamais ignorés** : dégradés, `url()`, `color-mix`, alpha sur fond inconnu, jeton local à un composant, `inherit` : chaque règle concernée est dans une liste `NON_RESOLUES` avec la raison, et **le test compare cette liste exactement** (une règle nouvelle non résolue fait échouer). Si la liste dépasse 25 règles, arrêt et remontée à Ali (le garde-fou coûte plus que prévu).
7. **Éléments désactivés** (`opacity` <= 0,5, `:disabled`) exclus (WCAG les exempte) ; texte "large" non distingué : 4,5:1 partout (plus strict).
8. **Autres paires en échec révélées par le parcours** : listées dans « Écarts » avec leur ratio ; corrigées dans cette story si le correctif est un changement de jeton ou de repli de moins d'une heure au total, avec test rouge avant / vert après ; sinon remontées à Ali avec estimation avant de continuer.
9. **Défense en profondeur réelle** : un e2e Playwright (`pc` et `iphone`) lit les couleurs **calculées par le navigateur** en sombre pour les trois composants (jsdom n'a pas de CSS), et trois captures sombres nouvelles sont ajoutées au visuel.

## Critères testables

Contrastes calculés par la formule WCAG de `contrast.test.ts` (luminance relative, `(L1 + 0,05) / (L2 + 0,05)`). Chaque critère « rouge avant » l'est sur `main` c01e961b.

### Rouge d'abord

1. **Étant donné** le nouveau test (`src/ui/theme/contrastCss.test.ts`, avec son noyau `src/ui/theme/cssContrastKit.ts`) exécuté **avant** tout changement de feuille, **alors** il échoue en thème sombre, avec les noms de règle et le ratio dans le message, au moins sur ces trois paires, chacune à **1,09:1** : `.ct-toast` (`Toast.css:9-10`, `accent-on` sur `nav-bg`), `.ct-projects__button--primary` (`SpacesScreen.css:213-216`), et l'interrupteur activé `.ct-switch[data-checked='true'] .ct-switch__track` sur la surface (`Switch.css:27`, `nav-bg` sur `--ct-color-bg`) ; et il est **vert en thème clair** pour ces trois-là. Le rouge est enregistré (commit « test seul », première assertion en échec). Sont rouges aussi, en sombre : l'anneau de focus du bandeau (`Toast.css:55`, 1,09:1) et le pouce de l'interrupteur désactivé (`#ffffff` sur `#ddd9e4`, 1,37:1, sans exemption en sombre).

### Correctif

2. **Étant donné** `tokens.css`, **alors** `--ct-color-on-nav` vaut `#ffffff` dans le thème clair et dans le thème sombre (résolu par le noyau), `Toast.css` (texte ligne 10 et anneau ligne 55), `SpacesScreen.css:216` et `WeekdayToggles.css:26` l'utilisent, et **aucune règle** ne combine plus un fond `--ct-color-nav-bg` avec un texte `--ct-color-accent-on` (garantie par le critère 5, énoncée ici pour mémoire).
3. **Alors** les quatre jetons d'interrupteur existent en clair et en sombre (valeurs du point 2 des décisions ou ajustées), `Switch.css` n'a plus de littéral de couleur ni de `var(--x, repli)`, et le pouce prend la couleur du jeton de son état.
4. **Rendu clair inchangé** : les couleurs résolues en clair du bandeau (`#ffffff` sur `#2e2150`), du bouton principal (`#ffffff` sur `#2e2150`, bordure `#2e2150`) et de l'interrupteur activé (piste `#2e2150`, pouce `#ffffff`) et désactivé (piste `#ddd9e4`, pouce `#ffffff`) sont les mêmes qu'avant, vérifiées par des assertions de valeurs.
5. **Alors** toutes les paires de même règle du critère 6 sont vertes dans les deux thèmes, y compris les trois paires du critère 1 (ratios sombres attendus : bandeau >= 17:1, bouton principal >= 17:1).

### Test de contraste exhaustif

6. **Paires de même règle** : le test parcourt **tous** les fichiers `src/**/*.css`, résout chaque règle avec texte et fond dans les deux thèmes et exige >= 4,5:1 ; un contrôle de garde échoue si moins de 100 paires sont analysées ou si l'une des règles suivantes n'est pas trouvée : `.ct-toast`, `.ct-projects__button--primary`, `.ct-projects__error` (preuve que le lecteur voit le CSS réel et non un fichier vide).
7. **Seuils** : texte 4,5:1 ; composants graphiques et anneaux de focus 3:1. Aucun seuil abaissé, aucune paire retirée de la liste existante de `contrast.test.ts` (qui reste, avec ses 12 paires, 1 graphique, les pastilles d'espace et l'écran Focus) ; la paire `--ct-color-on-nav` sur `--ct-color-nav-bg` (4,5:1) et celles des jetons d'interrupteur y sont ajoutées.
8. **Relations de composants (>= 3:1), sélecteurs réels, deux thèmes** : piste activée sur la surface (`--ct-color-bg`), pouce activé sur piste activée, piste désactivée sur la surface, pouce désactivé sur piste désactivée, anneau de focus du bandeau sur le fond du bandeau, anneau de focus des interrupteurs (`--ct-color-accent`) sur la surface. **Exemptions fermées** (comparées exactement, avec la raison de chaque ligne) : en clair, piste désactivée sur la surface (1,37:1) et pouce désactivé sur piste désactivée (1,37:1).
9. **Inventaire** : tout jeton `--ct-*` de couleur déclaré dans un fichier CSS figure dans une paire résolue, une relation, ou la liste `DECORATIFS` (raison obligatoire) ; un test dédié échoue sur un jeton nouveau non classé, et sur une entrée de `DECORATIFS` qui n'existe plus.
10. **Non résolus** : la liste `NON_RESOLUES` (critère 6 des décisions) est comparée exactement, chaque entrée avec sa raison ; elle compte au plus 25 règles.
11. **Cohérence des thèmes** : les tests existants « le bloc `prefers-color-scheme` et `data-theme="dark"` portent les mêmes valeurs » et « chaque jeton redéfini en sombre l'est aussi en clair explicite » passent sans modification, y compris pour les jetons nouveaux (`--ct-color-switch-*` définis dans les quatre blocs).
12. **Détection prouvée** : mutation du test, hors commit : remplacer `--ct-color-on-nav` par `--ct-color-accent-on` dans `Toast.css` fait échouer le critère 6 avec le nom `.ct-toast` et le ratio ; retirer un jeton d'interrupteur fait échouer le critère 9.

### Navigateur réel et captures

13. **E2E sombre** (`tests/e2e/UI-FIX-01.spec.ts`, projets `pc` et `iphone`, modèle `A-07.spec.ts:195-199` : `emulateMedia({ colorScheme: 'dark' })`) : le bandeau « Annuler » obtenu en terminant une tâche, le bouton principal de l'écran des espaces et projets, et un interrupteur activé de Réglages sont lus avec `getComputedStyle` ; texte >= 4,5:1 sur le fond calculé (en remontant aux ancêtres jusqu'à un fond opaque), piste >= 3:1 sur le fond de son parent. Rouge avant (1,09:1), vert après. Un second passage en clair vérifie qu'ils restent lisibles.
14. **Captures sombres de référence** (`tests/visual/capture.spec.ts`, entrées `dark: true`, sans maquette, `npm run visual` en CI) : `Annuler-Sombre` (bandeau après une action), `Espaces-Sombre` (reprendre le `prepare` de l'entrée `Espaces`, ligne 568, avec le bouton principal visible) et `Reglages-Sombre` (reprendre celui de l'entrée `Reglages`, ligne 499, interrupteurs activés et désactivés). Les images sont jointes à la fiche (noms de fichiers dans « Preuves ») et relues par qa-test contre `Main-Sombre.html` (fond, texte, onglets) ; aucune comparaison de pixels n'est ajoutée.

### Non-régression, bundle, documentation

15. **Tests existants** : `contrast.test.ts` (douze paires, graphique, pastilles, Focus, cohérence), `Switch.test.tsx`, `src/features/spaces` et `src/ui/Toast*.test.tsx` passent sans modification de leurs attentes ; aucun `skip`, aucun délai, aucun retry ; aucun seuil abaissé.
16. **Bundle** : le départ est mesuré avant et après chaque commit ; aucune feuille CSS n'est dans la mesure (preuve : `startBundle.test.ts:64`, `.js` seulement) ; variation attendue <= 10 octets (hachages CSS de la table de préchargement) ; net <= 0 hors ce bruit, sinon arrêt.
17. **Autres paires** : toute paire en échec hors des trois de l'audit est tracée dans « Écarts » (règle, ratio, thème) et traitée selon la décision 8.
18. **Documentation** : docs/decisions.md (ligne du 2026-10-18 : jetons `on-nav` et `switch-*`, exemption claire de l'interrupteur désactivé, test de contraste par règles), docs/journal.md, docs/backlog.md, docs/audit-1.0.md (B11). Aucun écart avec le PRD (section 5 ne définit pas le thème sombre).
19. **Vérifications** : tests du module en local seulement (`CT_TEST_WORKERS=1 npx vitest run src/ui --coverage.enabled=false`), lint et typage verts ; les e2e sont listés par `playwright test --list` et lancés en CI ; suite complète en CI (« suite verte »).

## Hors de cette story

- Un balayage de contraste de tous les écrans en navigateur réel (parcours du DOM de chaque écran, calcul par élément) : plus fiable que l'analyse statique pour les fonds hérités, mais bien plus long ; proposé à Ali (question 2), hors estimation.
- Taille de texte iOS (B12, retirée du PRD), couleurs des espaces et des onglets, nouvelles maquettes sombres.
- Toute fonction de la liste « Hors périmètre » du PRD (section 1).

## Plan par phases

1. **Noyau, lecteur CSS, parcours et relations, test rouge (2 h)** : `cssContrastKit.ts` (fonctions de `contrast.test.ts` déplacées, lecteur, résolution), `contrastCss.test.ts` (critères 6 à 10), vu rouge sur les trois paires ; commit « test seul ».
2. **Correctif (1,5 h)** : `--ct-color-on-nav`, jetons d'interrupteur, `Toast.css`, `SpacesScreen.css`, `Switch.css`, `WeekdayToggles.css` ; vert ; rendu clair inchangé (critères 2 à 5) ; autres paires éventuelles (décision 8).
3. **Inventaire, listes fermées, détection (0,5 h)** : critères 9 à 12.
4. **Navigateur réel et captures (0,5 h)** : critères 13 et 14.
5. **Bundle, documentation, qa-test puis code-reviewer** : réserve incluse dans les phases ; critères 15 à 19.

Découpage : 2 + 1,5 + 0,5 + 0,5 = 4,5 h (1,5 h de correctif, 3 h de garde-fou).

## Vérifications

- Local : tests du module (commande du critère 19) ; suite complète et visuel en CI.
- Preuves de détection : critères 1 et 13 rouges avant, 12 par mutation.
- Règle d'Ali : arrêt et alerte avant de continuer si l'estimation dérape de plus de 50 % (au-delà de 6,75 h) ; toute autre paire illisible révélée est remontée avant de continuer si elle dépasse la décision 8.
- Aucun fichier écrit hors du dépôt ; aucun secret ; interface en français, aucun texte en dur (cette story ne modifie aucun texte).
- Clôture refusée si un critère manque : le product-owner vérifie les 19 critères avant « fait ».

## Preuves (à remplir par l'agent)

| Élément | Valeur |
|---|---|
| Critère 1, rouge avant (commit, règles et ratios en échec) | |
| Critère 5, vert après (commit) | |
| Départ avant / après chaque commit (octets gzip, seuil 358 400) | |
| Nombre de paires analysées, de relations, de jetons décoratifs, de règles non résolues | |
| E2E sombre (critère 13), rouge puis vert | |
| Captures sombres (critère 14) : noms des fichiers | |
| Commandes locales et résultats | |

## Écarts

(aucun à ce jour)

## Questions à Ali (sans bloquer)

1. **Interrupteur désactivé en clair** : conserver `#ddd9e4` de la maquette (1,37:1 sur blanc, sous le 3:1 de WCAG 1.4.11, exemption inscrite) ou l'assombrir à `#8e87a3` (3,3:1, jeton `--ct-color-handle` existant, mais différent de la maquette `Reglages.html`) ? Recommandation : **conserver la maquette** (la référence visuelle prime, l'état se lit aussi à la position du pouce) et revoir après la 1.0.
2. **Balayage en navigateur réel de tous les écrans en sombre** (calcul du contraste de chaque élément texte du DOM, 34 écrans) en complément de l'analyse statique ? Recommandation : **plus tard**, après la 1.0 ; l'analyse statique plus les trois e2e couvrent les défauts connus pour 4,5 h au lieu de 10 h environ.
3. **Valeurs sombres de l'interrupteur** (lavande `#c9bee6` activé, `#6d6489` désactivé) : pas de maquette sombre de Réglages ; recommandation : valider sur la capture `Reglages-Sombre` plutôt que par écrit.
