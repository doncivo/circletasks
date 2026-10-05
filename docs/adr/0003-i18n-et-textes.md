# ADR 0003 — Internationalisation et textes d'interface

- Statut : accepté
- Date : 2026-10-01
- Tâche : PREP-02 (ordre 0)

## Contexte

L'interface est entièrement en français, l'anglais est une option (PRD 8) ; aucun texte ne doit être écrit en dur dans les composants (CLAUDE.md). Les maquettes ont des centaines de libellés. Les bibliothèques courantes (i18next + react-i18next, FormatJS) pèsent 15 à 40 Ko gzip et offrent surtout du chargement dynamique et des formats ICU dont une app à deux langues embarquées n'a pas besoin.

## Décision

Module maison typé dans `src/i18n/`, sans dépendance :

- `fr.ts` : **source de vérité**, objet `as const` groupé par écran / module (`app.name`, plus tard `today.title`, `tasks.add`…).
- `en.ts` : même arborescence, imposée par le type `Messages` dérivé de `fr.ts` (une clé manquante ou en trop casse `npm run typecheck`).
- `t(clé, params?)` : la clé est vérifiée à la compilation (`MessageKey`, union des chemins à points) ; si le texte français contient `{nom}`, l'objet de paramètres est **obligatoire** et typé.
- `translate(locale, clé, params?)` pour une langue explicite ; `setLocale` / `getLocale` ; repli sur le français, puis sur la clé.
- Les dates et heures se formatent avec `Intl` (format 24 h, `fr-FR`) dans des fonctions dédiées à ajouter par l'agent accessibility-i18n ; les pluriels avec `Intl.PluralRules` le moment venu.

Garde-fous automatiques :

- ESLint interdit tout texte JSX contenant une lettre et toute chaîne littérale dans `aria-label`, `aria-description`, `title`, `placeholder`, `alt`.
- Un test vérifie que `en.ts` a exactement les clés de `fr.ts` et les mêmes paramètres.

## Conséquences

- Zéro dépendance, quelques centaines d'octets dans le bundle, fonctionne à l'identique dans WebView2 et WKWebView.
- Ajouter un texte : clé dans `fr.ts`, puis traduction dans `en.ts` (sinon le typage échoue).
- `t()` lit la langue courante au moment du rendu : un changement de langue à chaud devra déclencher un nouveau rendu (langue stockée dans le store de réglages, ordre 1, agent settings-personalization).
- Les messages d'erreur techniques (exceptions, journaux) ne sont pas des textes d'interface : ils restent en dur et ne s'affichent jamais tels quels à l'utilisateur.
- Si un besoin ICU complexe apparaît (genres, pluriels imbriqués), un nouvel ADR réévaluera une bibliothèque.

## Avenant : catalogues chargés à la demande (PERF-02, 2026-10-05)

### Contexte

La décision initiale écartait le chargement dynamique (« deux langues embarquées »). PERF-02 mesure le catalogue anglais à ~16 Ko gzip du bloc de départ, pour une langue que l'utilisateur n'emploie pas par défaut.

### Décision

- Les deux langues restent **embarquées dans l'app** (aucun téléchargement réseau, fonctionne hors ligne) ; seul `fr.ts` est dans le bloc de départ, `en.ts` est un bloc séparé chargé par `import()` dans `src/i18n/index.ts`, seul endroit autorisé (garde-fou ESLint, ADR 0001, avenant PERF-02). Toujours aucune dépendance.
- Contrat de `src/i18n` :
  ```ts
  export function ensureLocale(locale: Locale): Promise<void>; // se résout toujours ; échec = repli français
  export function registerCatalog(locale: Locale, messages: Messages): void; // tests, ou catalogue obtenu autrement
  export function setLocale(locale: Locale): void; // lance ensureLocale en arrière-plan si le catalogue manque
  ```
- Règle d'appel pour tout changement de langue (réglage « Langue », fenêtres secondaires) : **`await ensureLocale(l)` puis `setLocale(l)`**, puis nouveau rendu. Appeler `setLocale` seul avant l'arrivée du catalogue donne une interface mixte (textes en français par repli, mais `getLocale()` vaut `en`, donc dates et pluriels `Intl` en anglais) ; toléré dans `FocusMiniWindow`, qui réaffiche à l'arrivée, à éviter ailleurs.
- `src/i18n` garde son état de module (`current`, `catalogs`) : c'est la couche des textes, pas le domaine ; l'exception ne s'étend pas à `src/domain`.
- Le test de parité des clés `fr` / `en` importe `en.ts` statiquement et reste valable.

### Conséquences

- iOS : bloc local servi par le protocole de l'app, chargé en quelques millisecondes ; aucune différence avec WebView2.
- Le futur réglage de langue (settings-personalization) applique la règle d'appel ci-dessus ; une troisième langue s'ajoute par une entrée de `loaders`.
