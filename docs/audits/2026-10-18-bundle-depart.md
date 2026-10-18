# Inventaire de la marge du bundle de départ (2026-10-18)

Demandé par Ali le 2026-10-18. Branche `bundle-01-marge`, depuis `origin/main` 50003153. Analyse seule : aucun fichier de `src` modifié, plafond inchangé (350 Ko gzip = 358 400 octets). Toutes les mesures sont des builds réels (Vite 8.3.2 / Rolldown), gzip par défaut de `node:zlib` comme `tests/bundle/startBundle.test.ts`.

## 0. Résumé pour Ali

1. Mesure de départ retrouvée à l'octet : 358 051 octets, 86 blocs, marge 349 octets (comme `startBundle.test.ts`).
2. La synchro pèse environ 66 Ko gzip (18 %) du départ pour une fonction invisible au premier affichage : moteur `src/sync` 28,5 Ko, `domain/sync` 12,3 Ko, `features/sync` 6,4 Ko, dépôts SQL de synchro 8,3 Ko, textes `sync.*` 10,7 Ko (au prorata).
3. Tout faire donne 256 591 octets (250,6 Ko) : marge 101 809 octets (28 % du plafond), mesurée par un vrai build de chaque palier cumulé (section 4).
4. Les paliers 1 à 3 (TaskDetail réel, hôtes montés en permanence, migrations) donnent 334 076 octets, marge 24 324 ; avec la synchro hors du départ (palier 4) : 288 637, marge 69 763 (19,5 %). Environ 20 à 30 h pour les quatre paliers.
5. Les onze stories restantes ajouteraient environ 3 à 10 Ko (central 6 Ko) si elles restaient dans le départ, d'après Y-TECH-02 (+4 887 octets) et N-03 (+4 080 octets) : le socle se finit, sans y revenir, avec les paliers 3 et 4.
6. Les paliers 1 et 2 seuls (17,4 Ko, 5 à 7 h) couvrent aussi l'estimation haute des onze stories, mais laisseraient peu de réserve pour la suite fonctionnelle (un lot comme Y-TECH-02 ou N-03 en consomme 4 à 5 Ko).
7. Piège mesuré : rendre paresseux un petit composant coûte souvent plus qu'il ne rend, à cause des blocs partagés que Rolldown crée (RestoreChoiceDialog seul : +417 octets ; fenêtre + textes : +33 octets net sur main ; elle ne rend (-5 110) qu'une fois la synchro sortie du départ).
8. Les migrations paresseuses rendent 6 626 octets mais ne raccourcissent pas le vrai démarrage (`migrate()` relit les sommes de contrôle de toutes les migrations appliquées à chaque lancement).
9. Le test compte 3 428 octets de pieds de page `sourceMappingURL` que l'app livrée par `tauri build` n'a pas (354 623 octets réels) : décision d'Ali, non utilisée comme levier.
10. Règle proposée : tout écran absent du premier affichage est à la demande (CLAUDE.md + avenant ADR 0001), gardée par une liste blanche des modules du départ lue par `startBundle.test.ts` (3 à 4 h, même mécanisme que `pairingBundle.test.ts`).

## 1. Reproduction de la mesure

- Définition identique au test : blocs `.js` atteints depuis `index.html` par `imports` du manifeste (récursif), somme de `gzipSync` de chaque fichier.
- Build : `NODE_ENV=production`, `TAURI_ENV_DEBUG=`, `VITE_CT_E2E_HOOKS=`, `--manifest`, sans `TAURI_ENV_PLATFORM` (donc cartes de source actives, comme dans le test).
- Résultat : **358 051 octets, 86 blocs, marge 349** (attendu : 358 051). Blocs principaux : `main` 141 494, `capture` 50 134 (partagé avec `capture.html`), `tokens` 47 113, `purge` 10 212, `container` 7 455.
- Banc d'essai : copie du dépôt (sans les tests) dans un dossier temporaire du worktree, une modification par palier, build identique, mêmes sommes. Les gains des sections 3 et 4 sont des builds ; seuls les chiffres « prorata » sont des estimations, et ils sont signalés.
- Avertissement Rolldown `INEFFECTIVE_DYNAMIC_IMPORT` : un seul, `TaskDetail` (importé statiquement par `DoneTasksScreen.tsx` et `tasks/index.ts`).

### Écart entre le test et l'app livrée (non utilisé comme levier)

`startBundle.test.ts` lance `npm run build` sans `TAURI_ENV_PLATFORM` : `vite.config.ts` active alors `sourcemap`, et chaque bloc reçoit un pied `//# sourceMappingURL=...`. `tauri build` exécute `npm run build` avec `TAURI_ENV_PLATFORM` posée (`tauri.conf.json` : `beforeBuildCommand`), donc sans carte de source. Mesuré : **358 051 avec cartes, 354 623 sans : 3 428 octets d'écart** (86 blocs). Aligner le test sur l'app livrée reviendrait à relever de fait le plafond de 3,4 Ko : décision d'Ali ; je ne l'ai pas comptée dans les marges.

## 2. Composition du départ par module source

Méthode : build avec cartes, `mappings` décodées (`@jridgewell/sourcemap-codec`), octets bruts attribués au fichier source de chaque segment (une ligne sans segment, comme une chaîne SQL ou un texte multiligne, revient au dernier fichier vu), puis gzip du bloc réparti **au prorata** des octets bruts. Les segments sans source (colle générée, internes de React) tombent dans « non attribué » (11,7 Ko). C'est une estimation : elle sert à classer ; les gains annoncés ensuite viennent de builds.

| Groupe | gzip (prorata) | brut |
| --- | ---: | ---: |
| node_modules/react-dom | 41 885 | 128 755 |
| src/i18n (catalogue français et `format*`) | 40 903 | 128 027 |
| src/domain (hors sync) | 34 936 | 94 758 |
| src/sync (moteur) | 28 492 | 91 670 |
| src/db/repositories | 25 741 | 90 794 |
| src/ui | 23 851 | 68 032 |
| src/features/tasks | 18 974 | 62 471 |
| src/platform | 14 692 | 39 773 |
| src/domain/sync | 12 250 | 36 758 |
| (non attribué : colle, internes) | 11 762 | 32 122 |
| src/features/app | 11 437 | 36 431 |
| src/db/migrations | 9 115 | 32 207 |
| src/features/today | 8 174 | 26 788 |
| node_modules/lucide-react | 6 429 | 17 154 |
| src/features/sync | 6 416 | 22 672 |
| src/features/settings | 5 376 | 17 896 |
| src/features/focus | 5 008 | 17 695 |
| src/features/search | 4 960 | 17 526 |
| src/features/reminders | 4 857 | 13 729 |
| src/features/capture | 4 850 | 13 405 |
| autres features (goals, calendars, checklists, events, spaces, routines, week, shortcuts, security, someday, updater) | environ 25 000 | |

Catalogues français par fichier (prorata) : `fr.ts` 7 068 ; `fr.syncPairing` 2 973 ; `fr.syncEngine` 2 344 ; `fr.appleReminders` 2 299 ; `fr.scan` 1 594 ; `fr.syncReset` 1 555 ; `fr.events` 1 382 ; `fr.syncForget` 1 268 ; `fr.calendars` 1 256.

Les migrations valent 9 115 au prorata mais 6 626 mesurés par build : le prorata surestime les modules à chaînes SQL.

## 3. Candidats au chargement à la demande

Gains en octets gzip du départ, **build d'essai** de chaque changement appliqué seul sur `main` (copie temporaire non commitée), sauf mention. Coût en heures : estimation (code + tests existants à adapter + revue), non mesurée.

| # | Candidat | Gain mesuré seul | Ce qui le retient aujourd'hui (fichier:ligne) | Coût | Risque |
| --- | --- | ---: | --- | ---: | --- |
| 1 | `TaskDetail` réellement paresseux | 1 816 | `features/today/TodayScreen.tsx:23`, `week/WeekScreen.tsx:23`, `goals/GoalsScreen.tsx:16`, `someday/SomedayScreen.tsx:10` (import depuis le barrel `../tasks`), `tasks/DoneTasksScreen.tsx:13`, `tasks/index.ts:10`. Essai : ces écrans prennent `TaskDetail` de `lazyScreens.tsx`, l'export du barrel est retiré ; l'avertissement `INEFFECTIVE_DYNAMIC_IMPORT` disparaît | 2 à 4 h | Faible : le panneau s'ouvre sur un geste, `preloadScreens` le charge déjà au repos. Tests de rendu à adapter (`TaskDetail.preload()`) |
| 2 | Hôte `OnboardingHost` | 6 982 | `App.tsx:53` (import), `:151` (monté en permanence) | 1 à 2 h | Faible : visible au premier lancement seulement, chargé juste après le premier rendu |
| 3 | Hôte `SearchOverlay` | 5 799 | `App.tsx:52`, `:154` (barrel `features/search`) | 1 à 2 h | Faible : ouvert par Ctrl+K ou le bouton ; `registerSearchShortcut` reste dans le départ |
| 4 | Hôtes `FocusHost` (790), `ShortcutsHelp` (553), `HolidayDetailHost` (169), `UpdateBanner` (409) | 1 921 (somme de mesures isolées) | `App.tsx:49,156` ; `:54,157` ; `:48,153` ; `:56,147` | 1 h chacun | Faible. `UpdateBanner` : le bandeau de mise à jour apparaît un instant plus tard |
| 5 | Hôte `EventEditorHost` | +2 347 seul ; **-3 297 après les autres leviers** | `App.tsx:48`, `:152` | 2 à 3 h | Faible, mais ne rend qu'avec les autres (blocs partagés). À mesurer en dernier |
| 6 | `DbFailureDetails` | +2 443 seul ; +106 après les autres : **à ne pas faire tel quel** | `App.tsx:7` : le fichier exporte aussi `DbOpenWatchdog` et `failureAlertKey`, qui restent statiques | scinder le fichier : 2 h | Écran d'échec : aucun retard admissible ; gain probable inférieur à 1,2 Ko (prorata) |
| 7 | Migrations non importées statiquement | 6 626 (bloc `migrations` isolé : 6 209) | `features/app/bootstrap.ts:11` (import), `:66` et `:261` (listes), `db/index.ts:10`, `settings/logs/LogsScreen.tsx:3`. Essai : `await import()` du dossier aux deux endroits | 2 à 3 h | **Moyen sur le fond** : `migrate()` (`db/migrator.ts:159`) recontrôle les sommes de toutes les migrations appliquées à chaque lancement ; le bloc est donc chargé à chaque démarrage, avant le premier rendu. Le plafond baisse, pas le temps de démarrage. Pour un vrai gain : table figée des (version, somme) dans le départ, SQL chargé seulement s'il y a une migration en attente (+4 à 6 h, test de cohérence) |
| 8 | `createSyncService` paresseux, seul | 10 511 | `bootstrap.ts:32` (import), `:298` (appel) ; `src/sync/index.ts:5` | 3 à 4 h | Moyen : voir 9 |
| 9 | **Synchro entièrement hors du départ** (service + `startSyncIntegration` + barrel allégé) | **43 853** | Barrel `src/sync/index.ts:5-15` (réexporte forget, reset, join, maintenance...) consommé par `features/sync/startSync.ts:11`, `tasks/trashUseCases.ts:5`, `sync/pairingHub.ts:3` et `pairingStatus.ts:5` (`JOIN_META`), `syncText.ts:11`, `JoinProgress.tsx:7`, `remoteChanges.ts:4`, `syncConflictUseCases.ts:12` ; `App.tsx:58` et `:281` (`startSyncIntegration`) ; `features/app/desktop.ts:8` et `:106` (`syncBeforeQuit`) | 10 à 14 h | **Moyen à élevé** : voir ci-dessous |
| 10 | `RestoreChoiceDialog` + textes `sync.restore` | **+33** sur `main` (composant seul +417 ; textes -384) ; **-5 110** une fois la synchro sortie (elle entraîne `syncText`, `resetText`, `forgetText`) | `App.tsx:57`, `:149` ; `RestoreChoiceDialog.tsx:7` importe `resetText` | 1,5 à 2 h (+ catalogue) | Faible. Seule, elle ne rend rien sur `main` : Rolldown extrait un bloc partagé `syncText` (3 342) du bloc principal |
| 11 | Détails de synchro et appairage : écrans déjà à la demande ; il reste leurs textes `sync.*` et `syncText`/`resetText`/`forgetText` | voir 10 et 15 | `fr.ts:119` (objet unique) | - | - |
| 12 | Feuille d'ajout `AddSheet` / `TaskCreateSheet` (et DatePicker, IconChooser, GoalAttachSwitch...) | 2 488 seul ; **7 507 après les autres** | `TodayScreen.tsx:25-26,360`, `WeekScreen.tsx:24-25,272`, `events/index.ts:3`, `useStandaloneTaskSheet.ts:5` ; `scheduleOf` est définie dans `TaskCreateSheet.tsx:22`, donc importée statiquement | 3 à 4 h | Moyen : la feuille s'ouvre sur un geste, la lenteur se verrait au tout premier toucher (utiliser `lazyScreen(...).preload`). `scheduleOf` à déplacer dans un petit module |
| 13 | `platform/calendars/memory.ts` (plateforme mémoire de test, inutile en production Tauri) | 1 926 (sur l'état après les autres leviers) | `container.ts:7` et `:140` (valeur par défaut), `platform/calendars/index.ts:2,6,17` | 1 à 2 h | Faible : le défaut du conteneur ne sert qu'aux tests |
| 14 | `FocusWindowRoot` (mini-fenêtre Focus) | 1 616 (idem) | `main.tsx:4`, `:24` | 1 à 2 h | Faible : fenêtre séparée, chargée à son ouverture |
| 15 | Catalogues français des écrans à la demande (détail plus bas) | 8 586 (sans aucun usage dans le départ) à 12 642 | `src/i18n/fr.ts` : objet unique importé statiquement par `i18n/index.ts` | 6 à 10 h (mécanisme) + 1 h par catalogue | Moyen : `t()` rend la clé brute si le catalogue manque (échec silencieux interdit par la règle du projet) |
| 16 | Dépôts SQL de synchro (`syncRepository` 5,3 Ko, `syncUnknown` 1,6, `syncConflicts` 1,4) et `domain/sync` restant (7,7 Ko) | non essayé (prorata 16 Ko) | `db/repositories/sql/index.ts:17` (fabrique de tous les dépôts) | 8 à 16 h | **Élevé, non recommandé** : construits au démarrage (`assertGuardEmpty`) et sur le chemin de toute écriture |

### Détail du levier 9 (la synchro)

Ce qui retient la synchro dans le départ après le seul levier 8 : le barrel `src/sync/index.ts` réexporte `forget.ts`, `reset.ts`, `join.ts`, `maintenance.ts` (qui tire `apply.ts`, `purge.ts`), alors que les consommateurs du départ n'en veulent que des lectures d'état (`readForgetStatus`, `readResetStatus`) et une constante (`JOIN_META`, valeur « join », définie `join.ts:32`). Essai : (a) `index.ts` ne garde que le journal, `syncAge` et les types ; (b) `startSync.ts` importe un barrel complet (`all.ts`), chargé par `import()` depuis `App.tsx:281` après le premier rendu et depuis `desktop.ts:106` ; (c) `JOIN_META` en constante locale ; (d) `trashUseCases` charge `maintenance` à la demande. Résultat : 358 051 -> 314 198. En vrai : garder `index.ts` complet pour les tests (25 fichiers l'importent) et faire importer des fichiers précis (`sync/log`, `sync/status`, une petite constante `JOIN_META` hors de `join.ts`) aux consommateurs du départ.

Deux variantes, à choisir :

- **A (celle mesurée)** : `bootstrap.ts` fait un `await import()` du service avant de créer le conteneur. Le plafond baisse de 43 853 octets, mais le bloc de synchro (environ 44 Ko gzip) est chargé avant le premier rendu : même JavaScript à analyser qu'aujourd'hui, une requête locale de plus. Neutre pour le démarrage, à confirmer par le projet Playwright `perf`.
- **B** : `container.sync` devient une façade qui charge le service après le premier rendu (vrai gain de démarrage, surtout sur iPhone). +4 à 8 h : 22 fichiers de test mentionnent `createSyncService`, 18 `startSync`. Risque plus élevé (reprise au premier plan, `syncBeforeQuit`, première synchro retardée de quelques dizaines de ms).

### Détail du levier 15 (catalogues)

Mesuré par suppression de l'espace de noms dans `fr.ts` (borne haute), sur le build après les leviers de code :

| Espace de noms | Gain (octets) | Usage dans le départ après les leviers de code |
| --- | ---: | --- |
| `sync.pairing` | 2 760 | aucun (la fenêtre `pairing.html` importe déjà `fr.syncPairing` directement) |
| `sync.reset` | 1 225 | aucun |
| `sync.forget` | 958 | aucun |
| `sync.field` | 775 | aucun |
| `checklists` | 762 | aucun |
| `stats` | 704 | aucun |
| `signing` | 431 | aucun |
| `sync.folder` | 366 | aucun |
| `updater` | 261 | aucun |
| `sync.key` | 259 | aucun |
| `done`, `trash` | 76 ; 95 | aucun |
| **Somme « sans usage » (build cumulé)** | **8 586** | |
| `scan` | 1 603 | une clé (`ScanButton.tsx`) |
| `importCsv` ; `appearance` | 1 262 ; 625 | une clé chacune (`features/app/undo.ts`) |
| `onboarding` | 954 | aucun si `OnboardingHost` est paresseux |
| **Somme avec ces quatre (build cumulé)** | **12 642** | clés restantes à déplacer dans un cœur |
| Espaces utilisés au démarrage (`appleReminders` 2 074, `calendars` 1 219, `events` 1 471, `reminders` 1 409, `routines` 1 081, `capture` 1 028, `spaces` 960, `sync.version`, `sync.status`, `sync.conflicts`...) | environ 12 000 cumulés | restent dans le départ, ou à scinder clé par clé |

Mécanisme : un catalogue d'écran enregistré par effet de bord à l'import du module de l'écran (un `registerNamespace` en tête du fichier chargé à la demande) ; type global inchangé par import de types. Garde obligatoire : en test et en développement, `t()` journalise et fait échouer le test quand une clé appartient à un espace paresseux non chargé. Le catalogue anglais (`en.ts`) est déjà à la demande en bloc entier.

## 4. Marges cumulées (builds réels)

Plafond 358 400. Ordre = rapport gain/heure décroissant.

| Palier cumulé | Départ (octets) | Marge (octets) | Marge / plafond | Gain du palier |
| --- | ---: | ---: | ---: | ---: |
| 0. `main` aujourd'hui | 358 051 | 349 | 0,1 % | |
| 1. + TaskDetail réellement paresseux | 356 235 | 2 165 | 0,6 % | 1 816 |
| 2. + hôtes Onboarding, Recherche, Focus, Aide raccourcis, Jours fériés, Mise à jour | 340 680 | 17 720 | 4,9 % | 15 555 |
| 3. + migrations non statiques | 334 076 | 24 324 | 6,8 % | 6 604 |
| 4. + synchro hors du départ (variante A) | 288 637 | 69 763 | 19,5 % | 45 439 |
| 5. + RestoreChoiceDialog et textes | 283 517 | 74 883 | 20,9 % | 5 120 |
| 6. + AddSheet / TaskCreateSheet | 276 025 | 82 375 | 23,0 % | 7 492 |
| 7. + calendriers mémoire, fenêtre Focus, EventEditorHost | 269 157 | 89 243 | 24,9 % | 6 868 |
| 8. + catalogues sans usage dans le départ | 260 723 | 97 677 | 27,3 % | 8 434 |
| 9. + `scan`, `importCsv`, `appearance`, `onboarding` | **256 591** | **101 809** | **28,4 %** | 4 132 |

Autres repères mesurés : `createSyncService` paresseux seul 347 540 ; synchro seule (barrel allégé, sans hôtes ni TaskDetail) 314 198 ; synchro + migrations 307 616.

Où ça me place une fois tout fait : 250,6 Ko sur 350, soit environ 100 Ko de marge. Les paliers 1 à 4 (20 à 30 h) laissent 69,8 Ko.

## 5. De quoi finir le socle ?

Réponse : **oui, avec les paliers 3 et 4 ; les paliers 1 et 2 seuls suffisent pour les onze stories mais laissent à peine de réserve pour la suite fonctionnelle.**

Évolution du départ à partir des builds de l'historique (même méthode, `git archive` de chaque commit) :

| Date / commit | Départ (octets) | Note |
| --- | ---: | --- |
| 2026-10-06 `04e55e01`, avant Y-TECH-02 | 334 146 | |
| 2026-10-07 `9c739a61`, fin de Y-TECH-02 | 339 033 | **+4 887** (avertissements, textes, comptes rendus) |
| 2026-10-08 `dd7ff16e`, fin du lot N1 + Y-IOS | 354 952 | environ +15 900 depuis le 7 octobre |
| 2026-10-08 `0cc6c1cf`, N-03 | 359 032 | **+4 080** (ramené ensuite à 358 794) |
| 2026-10-09 `ee86d86d`, version 0.3.0 | 357 996 | |
| 2026-10-15 `b039ad7f`, Y-10-FIX-01 | 358 320 | environ +276 |
| 2026-10-17 `50003153`, aujourd'hui | 358 051 | de 357 996 à 358 051 en huit jours : **+55 octets** sur une quinzaine de PR |

Le plafond est tenu depuis le 9 octobre en sortant à chaque fois le code d'une story du départ (Y-TECH-04 : 0 octet ajouté). Le coût s'est déplacé vers des contorsions par story (Y-FIX-04 : +530 octets pour la fenêtre de restauration, que seul un changement structurel rattrape).

Estimation de ce que les onze stories ajouteraient au départ **si elles n'étaient pas à la demande** (par analogie avec Y-TECH-02, N-03 et les correctifs récents ; ordres de grandeur, pas des mesures) :

| Story | Nature | Octets au départ (bas - haut) |
| --- | --- | ---: |
| Y-TECH-05 compte rendu du report | interface + textes | 1 500 - 4 500 (0 si dans la feuille de restauration, déjà à la demande) |
| Y-FIX-02, Y-FIX-03, Y-IOS-05, Y-IOS-07 | moteur de synchro + codes et textes d'avertissement | 100 - 600 chacune (le code moteur tombe à 0 au palier 4 ; restent les textes) |
| Y-IOS-02-FIX-01 | nouvel avertissement (Détails + bandeau) | 300 - 800 |
| T-TECH-01 | identifiants UUID v5, attente du premier cycle, migration de nettoyage | 500 - 1 500 (migration à 0 au palier 3) |
| SEC-01 | Rust seulement | 0 |
| N-TECH-02 | fenêtre de 7 jours, plafond 64 | 300 - 800 |
| N-FIX-02 | textes de notification | 100 - 300 |
| UI-FIX-01 | jetons CSS | 0 octet de JavaScript |
| **Total** | | **environ 3 100 - 10 000, central 6 000** |

Lecture : avec 349 octets de marge, la première de ces stories qui touche le départ casse le plafond (c'est déjà le cas de Y-FIX-04). Paliers 1 + 2 (17 720 octets de marge) couvrent l'estimation haute, mais un lot fonctionnel au rythme observé (Y-TECH-02 : 4,9 Ko, N-03 : 4,1 Ko) consomme un quart de cette réserve : il faudrait y revenir au bout de trois ou quatre lots de ce genre. Paliers 3 + 4 (69 763 octets) couvrent l'estimation haute près de sept fois.

## 6. Recommandations priorisées

1. **Tout de suite (5 à 7 h, rend 17,4 Ko)** : TaskDetail réellement paresseux ; hôtes `OnboardingHost` et `SearchOverlay` (12,8 Ko à eux deux) ; puis `FocusHost`, `ShortcutsHelp`, `HolidayDetailHost`, `UpdateBanner`. Un hôte à la fois, mesuré avec `startBundle.test.ts`.
2. **Garde-fou (3 à 4 h)** avant les suivants, pour que la marge ne se reperde pas (section 7).
3. **Migrations (2 à 3 h)** : à faire en sachant que cela ne change pas le temps de démarrage ; mieux, la table (version, somme) figée dans le départ.
4. **Synchro hors du départ (10 à 14 h, 43,9 Ko)** : variante A d'abord, B ensuite si la mesure `perf` iPhone le demande. Story dédiée (PERF-03) avec test de bout en bout de la synchro (démarrage, quitter, reprise au premier plan).
5. **RestoreChoiceDialog** : ne la sortir qu'après le point 4 (sinon +33 octets) ; textes `sync.restore` dans le catalogue de la fenêtre.
6. **Feuille d'ajout, plateforme mémoire, fenêtre Focus, EventEditorHost** (7 à 11 h, environ 14,4 Ko).
7. **Catalogues par écran** (8 à 12 h, 8,6 à 12,6 Ko) : seulement si le mécanisme est accepté ; garde de test sur `t()`.
8. À ne pas faire : dépôts SQL de synchro paresseux ; `DbFailureDetails` sans scission.

## 7. Règle et garde-fou automatique

### Règle

À écrire à deux endroits :

- `CLAUDE.md`, section « Règles » : « Tout nouvel écran, feuille, hôte ou catalogue de textes qui ne s'affiche pas au premier rendu d'Aujourd'hui est en chargement à la demande par défaut (`lazyScreen`, import par fichier jamais par barrel, textes avec l'écran). Y déroger exige une ligne dans `tests/bundle/startModules.txt`, justifiée dans la fiche de story. Le plafond de 350 Ko ne change pas. »
- ADR 0001, nouvel avenant PERF-03 à la suite de l'avenant PERF-02 (qui nomme déjà ces hôtes comme « prochain levier ») : la règle, les motifs ESLint (`ON_DEMAND_PATTERN` de `eslint.config.js`, 4 motifs aujourd'hui, étendu aux modules devenus paresseux), la liste blanche, et deux consignes de revue : refuser un import statique d'un écran déjà dans `lazyScreens.tsx`, refuser un nouveau barrel qui réexporte un composant d'écran.

`product-owner` (la fiche de story indique ce que la story ajoute au départ, en octets) et `qa-test` (mesure notée avant et après) reçoivent la même ligne, comme pour Y-TECH-04 critère 26.

### Garde-fou : liste blanche des modules du départ

Précédent dans le dépôt : `tests/bundle/pairingBundle.test.ts` fait exactement cela pour `pairing.html` (greffon qui relève `output.moduleIds` de chaque bloc, liste `ALLOWED_FILES`, liste `FORBIDDEN`).

Proposition pour `startBundle.test.ts` :

1. Le test construit déjà avec des cartes de source (aucun build de plus). Il lit, pour chaque bloc de départ, le champ `sources` de `<bloc>.js.map` et obtient l'ensemble des modules du départ. Sur `main` : **597 modules** (518 fichiers `src` répartis en 52 dossiers, 79 fichiers `node_modules` de 7 paquets : react, react-dom, scheduler, lucide-react, zustand, @tauri-apps/api, plugin-process). Le greffon de `pairingBundle.test.ts` donne 661 modules (il compte aussi les modules sans code émis) ; les cartes conviennent mieux ici.
2. Il compare à `tests/bundle/startModules.txt`, fichier trié, un chemin par ligne (les paquets `node_modules` par préfixe), généré une fois par `UPDATE_START_MODULES=1 npm run test:bundle`.
3. Échec dans les deux sens, avec un message qui nomme le module et son poids : « Module entré dans le départ : src/features/x/Y.tsx (brut 6,1 Ko, environ 1,9 Ko gzip) : le rendre à la demande, ou l'ajouter à tests/bundle/startModules.txt avec la justification dans la fiche de story. » Pour un module sorti : « sorti du départ : retirer la ligne » (la liste reste exacte, donc un retour en arrière est vu).
4. Le seuil de 350 Ko reste tel quel et reste le dernier juge.

Coût : 3 à 4 h (test, génération, premier fichier d'environ 600 lignes, documentation) ; 0 seconde de plus en CI (même build). Ce que cela impose aux stories : rien tant qu'elles n'ajoutent aucun fichier au départ ; sinon la liste est lue, la ligne ajoutée apparaît dans la revue et le `code-reviewer` la questionne. Limite : une croissance dans un fichier déjà listé n'est vue que par le plafond. Extension possible, non proposée par défaut : une colonne de poids brut par fichier dans le même fichier, pour détecter une croissance de plus de 2 Ko.

Filets déjà en place à étendre sans coût : `ON_DEMAND_PATTERN` (ESLint) et l'assertion `it.each` de `startBundle.test.ts` qui vérifie que `SettingsScreen`, `ScanDialog`, etc. restent hors du départ (y ajouter `TaskDetail`, `SearchOverlay`, `OnboardingHost`, `AddSheet`, le service de synchro).

## 8. Limites et ce qui n'est pas mesuré

- Le prorata sourcemap classe, il ne mesure pas : les gains par levier sont des builds. Les gains de catalogues sont des suppressions dans un build d'essai (le code qui y accédait n'a pas été réécrit) : bornes hautes pour `scan`, `importCsv`, `appearance`.
- Temps de démarrage réel (PRD 8 : PC < 2 s, iPhone < 1 s) non mesuré ici. Les leviers n'améliorent le vrai démarrage que si le code sorti n'est pas rechargé avant le premier rendu (migrations et variante A de la synchro : non).
- Ni test, ni lint, ni typage lancés sur les copies d'essai : les patrons d'essai sont des approximations pour mesurer (types lâches, copies de fonction). Le coût des tests à adapter est dans les heures.
- `capture.html` et `pairing.html` partagent le bloc `capture` (i18n, react) avec le départ ; les leviers 9 et 15 les touchent. `pairingBundle.test.ts` est à relancer après chacun.
- Estimation des onze stories : par analogie, sans mesure sur du code non écrit.
- Heures : mon estimation, sans mesure.
