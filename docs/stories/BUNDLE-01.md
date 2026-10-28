# BUNDLE-01 — Paliers 1 et 2 du bundle de départ, garde par liste blanche des modules, fin du bruit de hachage dans la mesure

Module : transverse (M12 Performance et démarrage, PRD section 8) · Ordre de construction : palier 1.0, **transverse, livrée avant la compilation iOS du lot** · Agents : **performance** (paliers, garde, mesure) + **ui-design-system** (hôtes d'interface, repli, frontières d'erreur, CSS) · Relecture : code-reviewer (après qa-test) · Estimation : **paliers 1 + 2 : 5 à 7 h ; garde par liste blanche : 3 à 4 h ; bruit de hachage : 1 à 2 h ; total 9 à 13 h**, **alerte à Ali au-delà de 19,5 h (+50 % du haut), ou de 10,5 h pour les paliers, 6 h pour la garde, 3 h pour le hachage** · Statut : fait, PR #61 fusionnée le 2026-10-19 ; QA, lint, typage et revue approuvés ; suite complète avec couverture verte (39255869894 / 39255876068)
Correctif sans équivalent au PRD (PRD section 8 : démarrage PC < 2 s, iPhone < 1 s ; le plafond de 350 Ko est une décision du projet, pas une ligne du PRD : aucun écart). Sources : `docs/audits/2026-10-18-bundle-depart.md` (sections 2 à 4, 7 et 8), `docs/stories/UI-FIX-01.md` (section « Bundle de départ »), `tests/bundle/startBundle.test.ts`, `src/features/app/lazyScreens.tsx`, `src/features/sync/RestoreChoiceHost.tsx` (modèle d'hôte à la demande), `vite.config.ts`. Note : la fiche `Y-FIX-02.md` citée comme modèle de structure n'est pas dans ce worktree (branche non fusionnée) ; la structure reprise est celle de `UI-FIX-01.md`.
Dépend de : PERF-02 (lazyScreens), Y-FIX-04 et Y-TECH-05 (livrés sur leurs branches). **Ordre dans le lot** : à faire sur un `main` qui contient les fusions de B2 (-30 octets) et B8 (-1 302 octets) ; les mesures de départ sont relevées à l'octet au premier commit (critère 6), les chiffres de l'audit (358 051) ne sont que des repères.

## Décision d'Ali (2026-10-18, mot pour mot)

« BUNDLE-01 : paliers 1 et 2, et la garde par liste blanche livrée quoi qu'il arrive, y compris avec la marge revenue. Traite le bruit de hachage CSS dans le même lot. »

Conséquence directe : la garde (phase 3) n'est pas conditionnée par la marge. Si les paliers rendent 17 Ko de marge, la garde est livrée quand même ; elle est le mécanisme principal, le plafond en octets devient le dernier juge.

## Contexte

- **Marge saturée depuis le 2026-10-16.** Le plafond (350 Ko gzip = 358 400 octets, `tests/bundle/startBundle.test.ts`, décision d'Ali, jamais relevé) est tenu depuis le 9 octobre en sortant à chaque fois le code d'une story du départ. Mesure sur `main` avant B2 et B8 : 358 336 (marge 64).
- **Incidents** : Y-FIX-04 a coûté +181 octets (fenêtre de restauration, contorsions de blocs partagés) ; Y-TECH-05 a coûté +199 puis a fini avec une marge de 43 octets ; UI-FIX-01 est arrivée avec **+72 octets de bruit sans aucune ligne de JavaScript changée** (voir ci-dessous). Chaque story qui touche le départ, même d'un octet, casse le plafond.
- **Inventaire** (audit du 2026-10-18) : les paliers 1 et 2 rendent 17 371 octets mesurés (TaskDetail -1 816 ; six hôtes -15 555 cumulés) et portent la marge à 17 720 sur la base de l'audit (358 051). Estimation des onze stories restantes : 3 100 à 10 000 octets si elles restaient au départ, central 6 000. Les paliers 3 (migrations) et 4 (synchro hors du départ) viennent **après la 1.0**.
- **Bruit de hachage** (UI-FIX-01, section bundle) : le nom haché d'un bloc inclut ceux de ses dépendances CSS ; une retouche d'une feuille renomme environ 85 blocs de départ (leurs noms sont écrits dans les tables de préchargement et les imports des autres blocs, ainsi que dans les pieds `sourceMappingURL`). Les noms hachés sont de l'aléa : le gzip de ces 85 renvois bouge de ±72 octets sans que le code change. Une mesure qui bouge sans cause de code rend la marge illisible et pousse à des arrêts à tort ou à des dépassements à tort.
- **Piège connu** (Y-TECH-05, Y-FIX-02, audit section 3) : un bloc à la demande qui importe un module du départ sort ce module du bloc principal et coûte des kilo-octets (blocs partagés créés par Rolldown). Rendre un petit composant paresseux peut coûter plus qu'il ne rend (RestoreChoiceDialog seul : +417). Chaque hôte est donc **mesuré seul, commit par commit**.

## Décisions retenues

1. **Palier 1 : `TaskDetail` réellement à la demande.** Il l'est déjà dans `lazyScreens.tsx:112` mais reste importé statiquement par `TodayScreen.tsx`, `WeekScreen.tsx`, `GoalsScreen.tsx`, `SomedayScreen.tsx` (barrel `../tasks`), `DoneTasksScreen.tsx` et `tasks/index.ts` (avertissement Rolldown `INEFFECTIVE_DYNAMIC_IMPORT`). Les écrans prennent `TaskDetail` de `lazyScreens.tsx`, l'export du barrel est retiré. **Préchargement** : `TaskDetail` n'est pas `onDemand` : `preloadScreens` le charge au repos après le premier rendu, comme les autres écrans ; ainsi l'ouverture d'une tâche n'ajoute aucune latence dans l'usage normal. Règle testable : **ouverture d'une tâche sans repli visible quand le préchargement a eu lieu** (critère 8). Quand l'ouverture précède le préchargement (tout premiers instants), le repli neutre existant de `lazyScreen` joue, avec sa frontière d'erreur.
2. **Palier 2 : six hôtes à la demande** : `OnboardingHost`, `SearchOverlay`, `FocusHost`, `ShortcutsHelp`, `HolidayDetailHost`, `UpdateBanner` (`App.tsx:49,53,56,153,154,156,157,147`). Modèle : `RestoreChoiceHost` (coque minuscule dans le départ qui lit l'état déjà présent au départ, puis rend `lazyScreen(..., { onDemand: true })` ; une fois montée, la fenêtre reste montée). Chacun a sa **frontière d'erreur** (celle de `lazyScreen` : message et « Réessayer », puis « Recharger ») et, s'il en a un, son **catalogue de textes à part, chargé avec lui** (jamais dans le départ). Reste dans le départ ce qui doit y rester : les magasins d'état qui décident l'affichage et `registerSearchShortcut` / `registerShellShortcuts` (le raccourci Ctrl+K existe avant que la recherche soit chargée ; son premier usage charge le bloc). `EventEditorHost` (gain isolé négatif, audit levier 5), `DbFailureDetails` et `RestoreChoiceDialog` ne sont **pas** dans ce lot. **Chaque hôte est un commit distinct, avec sa mesure ; un hôte dont le gain net mesuré est <= 0 n'est pas conservé** et est inscrit dans « Écarts » avec ses chiffres.
3. **Garde par liste blanche des modules du départ**, livrée quoi qu'il arrive. Le test existant `startBundle.test.ts` construit déjà avec cartes de source (`sourcemap` actif quand `TAURI_ENV_PLATFORM` est absente, `vite.config.ts:42`) : il lit le champ `sources` de la carte de chaque bloc `.js` du départ, obtient l'ensemble des modules source et le compare à une liste versionnée.
   - Fichier : **`tests/bundle/start-modules.json`** (JSON, car un commentaire `//` y est impossible et une « raison » est obligatoire). Forme : `{ "version": 1, "groupes": [ { "raison": "...", "prefixes": ["node_modules/react-dom/"], "fichiers": ["src/..."] } ], "ajouts": [ { "fichier": "src/...", "story": "XX-NN", "raison": "..." } ] }`. Les **groupes** portent la liste initiale (générée une seule fois, après les paliers, et rangée par raison : « coquille et premier rendu d'Aujourd'hui », « domaine », « dépôts SQL », « moteur de synchro (sortira au palier 4) », « paquets tiers »...). Les **ajouts** sont la seule voie d'extension : chaque entrée porte le fichier, l'**ID de la story** qui le justifie et une **raison** de 20 caractères au moins.
   - Échec **dans les deux sens**, message en français : « Module entré dans le départ : src/features/x/Y.tsx (source 6,1 Ko) : le rendre à la demande (`lazyScreen`, import par fichier, jamais par barrel), ou l'ajouter à `ajouts` de tests/bundle/start-modules.json avec l'ID de la story et la raison. » ; « Module sorti du départ : src/... : retirer la ligne de tests/bundle/start-modules.json. » (la liste reste exacte, un retour en arrière est vu).
   - La liste ne s'étend que par un commit explicite, visible en revue, que le code-reviewer questionne. `UPDATE_START_MODULES=1` réécrit la liste mais **est refusée quand `CI` est posée** et conserve les raisons existantes ; elle ne peut qu'enlever les modules sortis, et écrit les modules entrés dans `ajouts` avec une raison vide qui fait échouer le test (donc la raison est obligatoire).
   - **Le plafond en octets reste en plus**, inchangé (358 400), jamais relevé. Les chemins sont normalisés (relatifs à la racine du dépôt ; `node_modules/` à partir de la première occurrence).
   - Limite assumée : une croissance dans un fichier déjà listé n'est vue que par le plafond (audit section 7).
4. **Bruit de hachage : normaliser les noms hachés dans la mesure, sans toucher au build livré (recommandation retenue, à confirmer par Ali s'il préfère toucher le build).** Options chiffrées :
   - (a) `[hash:8]` plus court : réduit l'amplitude du bruit (moins d'octets aléatoires) sans le supprimer ; change le build livré et les noms de fichiers des mises à jour ; **écartée**.
   - (b) Noms de blocs stables (`chunkFileNames`/`assetFileNames` sans hachage ou hachage du seul contenu JS) : change la stratégie de cache de l'app livrée (WebView2 et WKWebView gardent des fichiers sans hachage après une mise à jour) ; risque de régression réelle pour supprimer un défaut de mesure ; Vite/Rolldown ne propose pas, à ma connaissance, d'exclure le CSS du hachage d'un bloc JS (`manualChunks` et `experimentalMinChunkSize` agissent sur le découpage, pas sur le calcul du nom) : **à vérifier dans la documentation de la version 8.3.2 en phase 1, et écartée de toute façon** ; **écartée**.
   - (c) **Normaliser dans la mesure** : avant le gzip, chaque nom de fichier haché du build (liste lue dans le dossier de sortie et le manifeste : blocs `.js`, `.css`, `.map`, ressources) est remplacé, partout où il apparaît dans le contenu, par un nom de **même longueur** dont le hachage est un **pseudo-hachage déterministe dérivé du nom logique** (empreinte du nom sans hachage, rendue dans le même alphabet et la même longueur). La mesure porte alors sur le code et non sur le hasard ; le build livré n'est pas touché (`vite.config.ts` inchangé).
   - **Pourquoi un pseudo-hachage et non une constante** : remplacer chaque hachage par `00000000` ferait baisser la mesure de quelques centaines d'octets (une constante compresse mieux que de l'aléa), soit un relèvement de fait du plafond, contraire à la décision d'Ali. Un pseudo-hachage de même entropie garde la mesure égale, en moyenne, à celle du build livré ; l'écart avec la mesure brute est relevé au critère 4.
   - Les noms qui se ressemblent (même nom logique) reçoivent le rang trié comme discriminant pour que deux blocs ne partagent jamais le même pseudo-hachage.
   - Le détail par bloc affiché par le test garde les vrais noms de fichiers.
5. **Documentation et règle** : la règle de CLAUDE.md reste (« tout écran hors premier affichage à la demande dès sa création, jamais après coup ») ; **la garde par liste blanche devient le mécanisme principal** et le plafond le dernier juge. Mises à jour : CLAUDE.md (ligne de règle), mémoire du projet (`circletasks-start-bundle-saturated.md` : garde en place, hachage normalisé, marge), ADR 0001 (avenant PERF-03 : règle, `ON_DEMAND_PATTERN` d'`eslint.config.js` étendu aux modules devenus paresseux, liste blanche, deux consignes de revue : refuser un import statique d'un écran déjà dans `lazyScreens.tsx`, refuser un nouveau barrel qui réexporte un composant d'écran), `docs/decisions.md`, `docs/journal.md`, `docs/backlog.md`, section « Bundle de départ » des fiches futures (« octets ajoutés au départ : mesure avant et après »). CLAUDE.md et la mémoire sont hors de `docs/` : ils sont écrits par l'agent qui développe, vérifiés par le product-owner à la clôture.

## Critères testables

## Reprise Codex du 2026-10-19 — passes séparées

- Product-owner : les 30 critères sont relus. Ordre de fusion d'Ali du 2026-10-19 : après #60 et avant #63 ; les mesures remplacent les anciens repères, sans modifier le plafond.
- Module : rebase sur `main` **1838dbe5**, après fusion de #62 et #60. Conflit initial limité au journal, avec conservation de toutes les entrées ; aucun conflit de code. Le recalage final n'a changé aucun fichier de `src`, des tests du bundle ni de la configuration ESLint par rapport à l'arbre déjà vérifié (`ea525f8d`).
- QA : 20 tests de rendu/chargement sur 4 fichiers verts ; bundle et fonctions de mesure/garde : 47 tests verts sur 4 fichiers. Départ normalisé **340 810 octets**, brut **340 758**, écart **52**, marge **17 590** sous le plafond inchangé de 358 400. Garde exacte sans extension de la liste. Les tests de frontières d'erreur vérifient les rejets et leurs messages.
- Revue distincte : les imports statiques retirés, les sept blocs à la demande, les reprises de chargement, la normalisation bornée et la garde dans les deux sens sont relus avec leurs tests. Aucun seuil, délai ou attente e2e modifié. Lint, typage et CI finale doivent être verts avant fusion ; aucune auto-approbation GitHub.
- Résultat de la passe : lint et typecheck verts, **revue approuvée** sur le diff et les tests. Aucun défaut bloquant relevé. Recalage sur `main` terminé ; suite CI complète avec couverture exigée avant fusion.

## Critères de la fiche initiale

Toutes les mesures sont des builds réels par `npm run test:bundle` (même méthode que `startBundle.test.ts`, gzip de `node:zlib`). Les octets sont relevés **avant et après chaque commit** et inscrits dans « Preuves ».

### Phase 1 : mesure sans bruit de hachage

1. **Rouge d'abord.** **Étant donné** deux dossiers de sortie synthétiques (arbre de fichiers de test, sans build) au JavaScript identique dont les noms hachés et leurs renvois dans les blocs diffèrent (comme après une retouche CSS), **quand** on applique la mesure actuelle (gzip direct), **alors** les deux mesures diffèrent d'au moins 1 octet ; le test `tests/bundle/bundleMeasure.test.ts` (qui vise la fonction de mesure extraite dans `tests/bundle/bundleMeasure.ts`) échoue sur ce cas avant le correctif. Rouge enregistré (commit « test seul »).
2. **Étant donné** ces mêmes deux dossiers, **quand** la mesure normalise les noms hachés, **alors** les deux mesures sont **identiques à l'octet** ; le pseudo-hachage est déterministe (deux appels, même résultat), de même longueur et du même alphabet que le hachage remplacé, et deux fichiers de même nom logique reçoivent deux pseudo-hachages différents.
3. **Preuve en build réel (mutation hors commit)** : une ligne de commentaire ajoutée à `src/ui/theme/tokens.css` ne change **pas** la mesure normalisée (identique à l'octet) alors que la mesure brute bouge (valeur relevée, attendue autour de ±72). Le test « même JS, CSS modifié -> même mesure » est automatisé par le critère 2 ; ce critère en consigne la preuve réelle dans « Preuves ».
4. **Aucun relèvement de fait** : sur le même build de `main`, la mesure normalisée et la mesure brute sont toutes deux relevées ; **borne asymétrique depuis le 2026-10-28 (décision d'Ali, UI-REFONTE-09)** : la mesure normalisée ne peut être plus **petite** que la brute de plus de **100 octets** (une mesure trop basse ferait croire qu'on est sous le plafond alors qu'on l'a dépassé : dépassement silencieux, exactement ce que la garde élimine), ni plus **grande** de plus de **300 octets** (une mesure trop haute ne fait qu'inquiéter à tort ; borne de bon sens contre un modèle des hachages périmé). Jusqu'au 2026-10-28 : écart absolu ≤ 100 ; dépassé à +143 avec 85 blocs à la demande (normalisé 337 914, brut 337 771), arrêt et remontée à Ali faits. Au-delà des bornes : arrêt et remontée à Ali. Le plafond reste `358 400` et la constante `LIMIT_BYTES` (`350 * 1024`) n'est pas modifiée (diff du plafond vide). Dette : modèle de normalisation sans bruit (backlog BUNDLE-02), quand le plafond redeviendra serré.
5. **Build livré inchangé** : `git diff` de `vite.config.ts`, `package.json` et de `src/` est vide pour la phase 1 ; seuls des fichiers de `tests/bundle/` et de `docs/` changent. Le détail par bloc affiché garde les vrais noms.

### Phase 2 : paliers 1 et 2

6. **Mesure de départ à l'octet** relevée avant tout changement de code de la phase 2 (valeur normalisée, nombre de blocs, marge) et inscrite dans « Preuves ». C'est la référence de tous les gains.
7. **Palier 1, mesure** : gain de `TaskDetail` mesuré à l'octet, dans un commit à part (attendu : environ 1 816 d'après l'audit ; s'il est inférieur à 1 000, arrêt et remontée à Ali).
8. **Palier 1, code** : plus aucun import statique de `features/tasks/TaskDetail` hors du bloc à la demande (ni `TodayScreen`, `WeekScreen`, `GoalsScreen`, `SomedayScreen`, `DoneTasksScreen`, ni `tasks/index.ts`) ; `TaskDetail` est ajouté à l'assertion `it.each` de `startBundle.test.ts` (bloc à la demande, importé dynamiquement, hors du départ) ; l'avertissement `INEFFECTIVE_DYNAMIC_IMPORT` n'apparaît plus dans la sortie du build ; `ON_DEMAND_PATTERN` d'`eslint.config.js` interdit un nouvel import statique du fichier.
9. **Préchargement, sans repli** : **Étant donné** `TaskDetail.preload()` attendu (ou `preloadScreens` terminé : l'attribut `data-screen-loaded-taskdetail` posé par `markLoaded`), **quand** on ouvre une tâche depuis Aujourd'hui, Semaine, Projets, Un jour et Terminées, **alors** le panneau est rendu **sans** `.ct-app__placeholder` ni aucun repli à aucun instant (test de rendu avec Testing Library, puis e2e Playwright `pc` et `iphone` qui attend l'attribut avant d'ouvrir). **Étant donné** le préchargement pas encore fait, **alors** le repli neutre s'affiche puis le panneau, sans erreur ni perte d'état.
10. **Palier 1, échec de chargement** : un `import()` de `TaskDetail` qui échoue affiche le message de la frontière d'erreur et « Réessayer » (puis « Recharger » au second échec), sans écran blanc.
11. **Palier 2, un hôte par commit** : `OnboardingHost`, `SearchOverlay`, `FocusHost`, `ShortcutsHelp` (PC seulement), `HolidayDetailHost`, `UpdateBanner`, chacun dans un commit distinct dont le message porte « BUNDLE-01 » et la mesure avant/après. Ordre de travail : par gain décroissant (Onboarding 6 982, Recherche 5 799, puis Focus 790, Aide 553, Mise à jour 409, Jours fériés 169, d'après l'audit).
12. **Palier 2, gain net par hôte** : chaque hôte conservé a un gain net mesuré **> 0** ; un hôte qui ne rend rien (blocs partagés) est annulé et noté dans « Écarts » avec ses octets. Aucun hôte n'est conservé « pour la règle » s'il augmente le départ.
13. **Palier 2, comportement inchangé** : au premier lancement, l'accueil s'affiche ; Ctrl+K (PC) et le bouton de recherche ouvrent la recherche avec le focus dans le champ ; une séance Focus démarre et sa fenêtre s'affiche ; « ? » ouvre l'aide des raccourcis ; le détail d'un jour férié s'ouvre ; le bandeau de mise à jour apparaît quand une mise à jour est disponible. Les **e2e existants passent sans aucune modification de leurs attentes** (`pc` et `iphone`, en CI) ; les tests de rendu ne sont adaptés que par `preload()` ou l'attente du bloc.
14. **Palier 2, pas de latence ajoutée au premier geste** : la première ouverture de la recherche ou de la séance Focus passe par `preload()` déclenché au repos (les hôtes ne sont pas `onDemand` si leur ouverture est un geste de l'utilisateur) ou, à défaut, sans repli visible ; la décision de chaque hôte (préchargé ou chargé à l'apparition de son état) est notée dans le commentaire de sa coque. `OnboardingHost` et `UpdateBanner` (apparition pilotée par l'état) peuvent être `onDemand`.
15. **Palier 2, échec de chargement** : pour chacun des six hôtes, un `import()` en échec montre le message et « Réessayer », jamais un hôte absent sans trace (test paramétré ; l'échec est journalisé `screen-load`).
16. **Aucun écran manquant** : un test charge chaque export de `lazyScreens.tsx` et chaque hôte à la demande et vérifie qu'un composant est rendu ; l'inventaire des `ScreenName` est exact ; la liste de `startBundle.test.ts` (`it.each`) comprend en plus `TaskDetail`, `SearchOverlay`, `OnboardingHost`, `FocusHost`, `ShortcutsHelp`, `HolidayDetailHost`, `UpdateBanner` (sources exactes selon l'arborescence) et chacun est un bloc à la demande importé dynamiquement.
17. **Marge après les paliers** : le départ mesuré après le palier 2 laisse une marge **>= 15 000 octets** (audit : 17 720 sur 358 051) ; entre 12 000 et 15 000, signalé dans « Écarts » ; en dessous de 12 000, arrêt et remontée à Ali.
18. **Autres pages** : `pairingBundle.test.ts` (fenêtre de la clé) et le bloc partagé avec `capture.html` passent ; aucun bloc de départ de `pairing.html` ne grossit.

### Phase 3 : garde par liste blanche

19. **Rouge d'abord.** Un module ajouté au départ **fait échouer la garde avec son nom** : preuve par mutation hors commit (un import statique ajouté dans `App.tsx` d'un fichier de feature jamais listé) ; message attendu : « Module entré dans le départ : <chemin> », avec la taille du fichier source et la consigne en français. Test de la garde lui-même : fonction pure de comparaison testée sur des listes synthétiques (entré, sorti, conforme) dans `tests/bundle/startModules.test.ts`, rouge avant l'écriture de la fonction.
20. **Module sorti** : un module de la liste qui n'est plus dans le départ fait échouer le test avec « Module sorti du départ : <chemin> : retirer la ligne ».
21. **Garde indépendante de la marge** : la mutation du critère 19 est faite **alors que la marge est de 15 000 octets ou plus** (après les paliers) : le plafond est vert, la **garde est rouge**. C'est la preuve de la décision d'Ali (livrée quoi qu'il arrive).
22. **Forme de la liste** : `tests/bundle/start-modules.json` est valide ; chemins normalisés, sans doublon, triés dans chaque groupe ; chaque fichier `src/...` listé **existe** sur disque ; chaque `ajouts` porte `fichier`, un ID de story de la forme du backlog et une `raison` de 20 caractères au moins ; une entrée sans raison ou sans story fait échouer le test.
23. **Liste initiale après les paliers** : générée une seule fois, après la phase 2 ; elle ne contient **aucun** des modules sortis (TaskDetail, les six hôtes, leurs CSS et leurs fichiers de texte à part) : test explicite sur ces noms ; elle compte moins de modules que les 597 de l'audit.
24. **Mise à jour contrôlée** : `UPDATE_START_MODULES=1 npm run test:bundle` réécrit la liste et conserve les raisons ; il est **refusé quand la variable `CI` est posée** (message clair, code de sortie non nul) ; un module entré apparaît dans `ajouts` avec une raison vide, ce qui garde le test rouge jusqu'à la saisie de l'ID et de la raison.
25. **Plafond inchangé et dernier juge** : `LIMIT_BYTES` vaut toujours `350 * 1024` ; l'assertion `expect(total).toBeLessThan(LIMIT_BYTES)` est conservée ; le diff du plafond est vide.
26. **Coût** : aucun build de plus (la garde réutilise le `beforeAll` existant) ; temps de `npm run test:bundle` en CI inchangé à 5 s près ; `test:bundle` fait partie du workflow de suite (preuve : la ligne du workflow citée dans « Preuves »).

### Documentation et clôture

27. **Règle et mémoire** : CLAUDE.md porte la règle avec la garde comme mécanisme principal et le plafond comme dernier juge ; l'entrée de mémoire `circletasks-start-bundle-saturated.md` est mise à jour (marge réelle après la story, existence de la liste, normalisation des hachages) ; ADR 0001 reçoit l'avenant PERF-03 (règle, motifs ESLint, liste blanche, deux consignes de revue) ; `docs/decisions.md`, `docs/journal.md` et `docs/backlog.md` à jour.
28. **Fiches futures** : le gabarit de la section « Bundle de départ » des fiches (octets ajoutés au départ, mesure avant et après, ligne `ajouts` éventuelle) est noté dans `docs/decisions.md` ; la story UI-FIX-01 (réserve de ±10 octets de hachage et arrêt vers « paliers BUNDLE-01 ») est mise à jour : le bruit n'existe plus.
29. **Non-régression** : tests du module en local seulement (`npm run test:bundle` et les tests des écrans et hôtes touchés), lint et typage verts ; aucun test désactivé, aucun délai allongé, aucun `skip`, aucun seuil abaissé ; suite complète et e2e en CI (« suite verte ») ; **une seule compilation iPhone du lot** après BUNDLE-01, pas une par essai.
30. **Aucun échec silencieux** : chaque chargement d'hôte ou d'écran en échec est visible (message de la frontière d'erreur) et journalisé ; aucun texte en dur (les messages réutilisent `app.screenError`, `app.screenRetry`, `app.screenReload` ; seuls les messages de la garde, qui est un test et non l'interface, sont en français dans `tests/`).

## Hors de cette story

- **Paliers 3 et 4** de l'audit (migrations non statiques ; synchro hors du départ, variantes A et B ; `RestoreChoiceDialog` ensuite) : **après la 1.0**, story dédiée (PERF-03) avec test de bout en bout de la synchro.
- Catalogues français par écran (levier 15), feuille d'ajout, plateforme de calendriers mémoire, fenêtre Focus (`FocusWindowRoot`), `EventEditorHost`, `DbFailureDetails`, dépôts SQL de synchro : non retenus (audit sections 3 et 6).
- Alignement du test sur l'app livrée sans cartes de source (3 428 octets de pieds `sourceMappingURL` comptés, décision d'Ali : laissés tels quels, non utilisés comme levier).
- Toute fonction de la liste « Hors périmètre » du PRD (section 1).

## Plan par phases

1. **Mesure sans bruit (1 à 2 h)** : extraire la mesure dans `tests/bundle/bundleMeasure.ts`, test rouge sur arbres synthétiques, normalisation par pseudo-hachage, preuve réelle par commentaire dans `tokens.css` (critères 1 à 5). En premier, pour que tous les chiffres suivants soient exacts.
2. **Palier 1 (2 à 3 h)** : `TaskDetail` à la demande, préchargement, tests (critères 6 à 10), commit et mesure.
3. **Palier 2 (3 à 4 h)** : un hôte par commit dans l'ordre du critère 11, mesure et revue de chaque commit, e2e existants en CI (critères 11 à 18).
4. **Garde par liste blanche (3 à 4 h)** : fonction de comparaison et son test rouge, lecture des cartes, liste générée après la phase 3, messages, mise à jour contrôlée, mutation à marge haute (critères 19 à 26).
5. **Documentation, qa-test puis code-reviewer** : règle, mémoire, ADR, gabarit des fiches (critères 27 à 30). Les 30 critères sont vérifiés par le product-owner avant « fait ».

Découpage : 1,5 + 2,5 + 3,5 + 3,5 + marge de documentation incluse = 9 à 13 h.

## Vérifications

- Local : `npm run test:bundle` et tests du module seulement ; suite complète, e2e `pc` et `iphone`, perf et bundle en CI ; fusion dans `main` seulement après « suite verte » et relecture approuvée.
- Preuves de détection : critères 1, 19 et 21 rouges avant (ou par mutation hors commit), 3 par mutation sur `tokens.css`.
- Règle d'Ali : arrêt et alerte si l'estimation dérape de plus de 50 % (19,5 h en tout, ou par partie) ; arrêt si la marge après paliers est < 12 000, si le gain de `TaskDetail` est < 1 000, ou si l'écart de la normalisation dépasse 100 octets.
- Aucun fichier écrit hors du dépôt ; aucun secret ; interface en français.
- Clôture refusée si un critère manque.

## Preuves (à remplir par l'agent)

| Élément | Valeur |
|---|---|
| Critère 1, rouge avant (commit, mesures différentes sur arbres synthétiques) | |
| Critère 3, mesure brute et normalisée avant/après le commentaire dans `tokens.css` | |
| Critère 4, mesure brute et normalisée de `main`, écart | |
| Critère 6, départ de référence (octets, blocs, marge) | |
| Critère 7, gain de TaskDetail (octets) | |
| Critères 11 et 12, gain net de chaque hôte (octets) et hôte éventuellement annulé | |
| Critère 17, marge après paliers | |
| Critère 19, 20 et 21, sortie de la garde rouge (nom du module) et marge au moment de la mutation | |
| Critère 23, nombre de modules de la liste initiale | |
| Critère 26, ligne du workflow qui lance `test:bundle`, temps avant/après | |
| E2E `pc` et `iphone` : identifiants des exécutions de CI | |
| Commandes locales et résultats | |

## Écarts

(aucun à ce jour)

## Questions à Ali (sans bloquer)

1. **Normalisation des hachages dans la mesure ou changement du build ?** Recommandation : **dans la mesure** (décision 4, option c). Elle mesure le code et non le hasard, ne touche pas au build livré ni au cache des mises à jour, et le pseudo-hachage de même entropie évite tout relèvement de fait du plafond. Si Ali préfère toucher le build (noms de blocs sans dépendance au CSS), il faut ajouter à la story le test de cache de l'updater PC et de la mise à jour SideStore, et la durée monte d'environ 3 à 4 h.


## Clôture du 2026-10-19

PR #61 fusionnée dans `main` par le commit `772d0f29`, après les passes QA et revue consignées ci-dessus et la CI complète avec couverture (39255869894 / 39255876068). Les mentions d’attente dans les sections précédentes sont historiques. Les preuves rouges restent conservées.
