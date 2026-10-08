# ADR 0014 — Journal technique persistant

- Statut : accepté (contrat ; implémentation par ios-mobile pour Rust, settings-personalization pour `src/platform/logs` et l'écran)
- Date : 2026-10-08
- Stories : I-04 (M16, ordre 5, lot F, phase 3) ; sert P-04-iOS (marqueur, récupération) et FILES-IOS-01 (purge des temporaires)
- Complète : ADR 0006 (`logDesktopFailure`, D-03), ADR 0009 (avenant lot F), ADR 0011 §2.3 (journaux de la synchro, modifié par renvoi, voir « Conséquences »)
- Vérifié dans le code le 2026-10-08 : `src/platform/desktop/log.ts` (`console.warn` seulement ; `logFailure` = `logDesktopFailure`), appels relevés par la fiche I-04 (dont `src/sync/log.ts`, qui passe déjà par `logFailure('sync', …)`), trois `eprintln!` Rust (`backup.rs` marqueur, `desktop.rs` récupération, `sync/mod.rs` `log::event` hors production), `sync::log::event` muet en production (avenant 16 de l'ADR 0011)

## Contexte

Le PRD (section 10) remplace l'inspecteur Safari par un écran de logs interne (I-04) : sur iPhone, sans Mac, c'est le seul moyen de lire un échec. Aujourd'hui rien n'est conservé (`console.warn`). La base ne convient pas : une restauration (P-04) la remplace et effacerait les entrées qui l'expliquent ; une table toucherait `src/db` (interdit dans ce lot) et risquerait la synchronisation. Règles : aucun échec silencieux, aucun contenu personnel dans un journal (ADR 0011 §2.3, audit B6).

## Décision

### 1. Stockage (Rust, `src-tauri/src/applog.rs`, sans `cfg` : PC et iPhone)

- Dossier **`<app_config_dir>/logs/`** : fichiers **`circletasks.log`** (courant) et **`circletasks.log.1`** (précédent), **256 Kio chacun**, 512 Kio au total au plus. Jamais dans le dossier iCloud, jamais dans `backups/`, jamais synchronisé ni publié ; une restauration (P-04) ne touche que `circletasks.db*` et `backups/` : **le journal survit**.
- Format : **une entrée JSON par ligne** (JSON Lines, UTF-8) `{ "at": ISO UTC, "scope", "code", "detail", "n"? }` ; ajout en fin (`append`), pas de `.tmp`. **Rotation à l'écriture** : si taille actuelle + ligne > 256 Kio, `circletasks.log` est renommé en `.1` (l'ancien `.1` est remplacé), puis un nouveau fichier est créé.
- Ligne de plus de **4 Kio** : `detail` tronqué, suivi de `[tronqué]`. `scope` : `^[a-z0-9][a-z0-9-]{0,39}$` ; `code` : `^[a-z0-9][a-z0-9.-]{0,63}$` ; une valeur hors forme devient `invalid` ; `at` hors forme ISO remplacé par l'heure de Rust ; caractères de contrôle retirés.
- **Liens** : `logs/` contrôlé par `symlink_metadata` (lien, jonction ou autre chose qu'un dossier → `unsafe-file`, rien n'est lu ni écrit) ; chaque fichier ouvert sans suivre de lien (`O_NOFOLLOW` sous `cfg(unix)`, attribut de point d'analyse refusé sous Windows) ; un fichier qui est un lien n'est ni lu ni écrit.
- Concurrence : un `Mutex` global ; écritures et lectures hors du fil de l'interface (`spawn_blocking`).
- **Seconde barrière Rust** : le `detail` reçu passe le même filtre de forme que `sanitizeLogDetail` (chemins, `file://`, e-mail, URL avec requête, `Bearer`, hexadécimal de 32 caractères ou plus, plus de 300 caractères) ; vecteurs partagés `tests/fixtures/logs/sanitize-vectors.json`, lus par Vitest et `cargo test`.
- Limitation de débit : un même couple (`scope`, `code`) au plus **10 fois par minute** ; au-delà, compté et résumé par une entrée `log` / `suppressed` (`n`) à la minute suivante (une rafale ne chasse pas les entrées utiles). Entrées identiques consécutives fusionnées dans les tampons (`n`).

### 2. Commandes Tauri

| Commande | Entrée | Sortie | Erreurs (`{ code }`) |
| --- | --- | --- | --- |
| `log_append` | `{ entries: LogEntryIn[] }` (100 au plus, ligne ≤ 4 Kio) | `{ written: number, writeError: string \| null }` | `too-many` (rien n'est écrit), `unsafe-file`, `disk-full`, `io` |
| `log_read` | `{ max: number }` (1 à 500) | `{ entries: LogEntry[], writeError: string \| null }` (les `max` dernières, `.1` puis courant, plus récente en dernier) | `unreadable`, `unsafe-file`, `io` |
| `log_clear` | — | `{ cleared: true }` (supprime les deux fichiers, puis écrit `logs` / `logs-cleared` en première entrée) | `unsafe-file`, `io` |

- Lecture tolérante : fichier non UTF-8 lu avec remplacement ; ligne non JSON rendue comme entrée `log` / `unreadable-line` (marquée) ; jamais de panique.
- `writeError` : dernier échec d'écriture du processus (y compris des écritures internes à Rust), effacé à la prochaine écriture réussie.
- Capabilities : **`src-tauri/capabilities/logs.json`** (`"windows": ["main"]`, `"platforms": ["windows"]`) et **`logs-ios.json`** (`"windows": ["main"]`, `"platforms": ["iOS"]`), chacune **exactement** `allow-log-append`, `allow-log-read`, `allow-log-clear` ; aucune capability de `pairing`, `capture` ni `focus` ne les porte (`config.rs`). `build.rs` : trois commandes ajoutées au manifeste ; gestionnaires PC et iOS.
- Écritures internes à Rust : **`applog::write(scope: &'static str, code: &'static str)`** — aucun texte dynamique possible par construction. Avant `applog::init(dir)` (début du `setup` PC et iOS), les entrées sont gardées en mémoire (100 au plus) puis écrites. Les trois `eprintln!` deviennent : `backup` / `restore-marker-failed` (renvoyé aussi au front, ADR 0009 avenant lot F B6), `backup-recovery` / `<code>` (récupération au démarrage, PC et iPhone), et `sync::log::event` (voir « Conséquences »). **Le seul `eprintln!` du code est dans `applog`** (copie sur la sortie d'erreur en développement et sous `test-hooks`).

### 3. TypeScript (`src/platform/logs/`, seul dossier à nommer les commandes)

- `types.ts` : `LogEntry { at; scope; code; detail; n? }`, `LogCategory = 'sync' | 'notifications' | 'errors'`, `categoryOf(scope)` : `sync*` → Synchro ; `notifications`, `reminders*` → Notifications ; le reste → Erreurs ; `LogJournal { record(scope, error): void; flush(): Promise<void>; read(max?): Promise<LogEntry[]>; clear(): Promise<void>; status(): { writeError: string | null; readError: string | null }; subscribe(listener): () => void }`.
- `sanitize.ts` : **`sanitizeLogDetail(raw: string): string`** (chemins Windows et POSIX, `file://`, URL avec requête, e-mail, `Bearer …`, hexadécimal ≥ 32, chaîne > 300 caractères → `[masqué]`) et `codeAndDetailOf(error: unknown)` : `code` = `error.code` s'il a la forme d'un code, sinon premier mot du texte s'il en a la forme, sinon `error.name`, sinon `unknown` ; `detail` = reste, assaini. Dans `src/platform`, **pas dans `src/domain`**.
- `buffer.ts` : tampon circulaire de **500 entrées** ; vidage vers `log_append` par lots de 100 **toutes les 2 s**, à `visibilitychange` → `hidden` et à `pagehide` ; un lot refusé reste au tampon (nouvel essai au vidage suivant).
- `tauriLogs.ts` (transport réel), `memory.ts` (faux des tests ; crochet `globalThis.__ctLogs` sous `import.meta.env.DEV` seulement), `index.ts` : `openLogJournal(runtime, os, windowLabel)` : seule la fenêtre **`main`** écrit dans le fichier ; la mini-fenêtre PC (`capture`), `focus` et `pairing` restent sur la console (sans capability, sans état d'échec) ; navigateur de développement : mémoire.
- **`logFailure(scope, error)` (`src/platform/desktop/log.ts`) est le seul point d'entrée** (signature inchangée ; `logDesktopFailure` reste un alias de la même fonction, aucun appel existant n'est modifié) : `console.warn` (inchangé) puis `record` dans le journal installé par `installLogJournal(journal)` au démarrage ; avant installation, les entrées attendent dans le tampon.
- **Règle écrite pour les appelants** : ne passer que des codes, compteurs et identifiants techniques — jamais un titre, une note, un nom de projet, une valeur de champ, un chemin, une clé ou un jeton. L'assainissement n'est qu'une seconde barrière (un titre ne se reconnaît pas à sa forme) : la preuve est le test de sentinelle (I-04 critère 6).

### 4. Écran (I-04, `src/features/settings/logs/`)

- Accès : lien « Logs » de la ligne « Version … » de Réglages › À PROPOS, **PC et iPhone** (code partagé ; décision du 2026-10-08, à valider par Ali). Filtres Tout / Synchro / Notifications / Erreurs ; 500 entrées au plus ; heure locale 24 h.
- Export par **`container.files.save`** (FILES-IOS-01 sur iPhone : panneau de partage ; PC : « Enregistrer sous ») : `circletasks-logs-AAAAMMJJ-HHMM.txt`, `text/plain`, en-tête et lignes de la fiche ; annulation = rien ; échec = message visible avec le code.
- **Aucun échec silencieux** : `writeError` ou `readError` → « Le journal n'a pas pu être écrit » (ou l'échec de lecture) avec le code, en rouge, sur l'écran **et** sur la ligne « Logs » de Réglages ; les entrées de la session restent lisibles depuis le tampon ; le message disparaît à la prochaine écriture réussie.

### 5. Limites assumées

Plantages natifs (Swift, WebKit, panique Rust hors `applog`) non capturés ; entrées des 2 dernières secondes perdues si l'app est tuée ; le journal est compris dans la sauvegarde d'appareil d'iOS (aucun contenu personnel) ; aucune verbosité réglable, aucun envoi automatique, aucune télémétrie (hors périmètre).

## Conséquences

- **ADR 0011 §2.3 modifié par renvoi** : « En production, le journal technique Rust de la synchro ne conserve rien » devient : en production, `sync::log::event(event, detail)` inscrit **le seul `event`** (`&'static str`) par `applog::write("sync-rust", event)`, sans `detail` ; en développement et sous `test-hooks`, comportement actuel (sortie d'erreur via `applog`, captures). Les journaux TS de la synchro (`src/sync/log.ts`) sont désormais conservés : leur contenu reste celui permis par §2.3 (codes, compteurs, noms stricts, identifiants d'appareil et d'époque), revu par security-privacy.
- Contrôles statiques (I-04 critère 9) : aucun `console.warn|error|log` hors `src/platform/desktop/log.ts` ; aucun `eprintln!` hors `applog.rs` ; aucun appel de `log_append` / `log_read` / `log_clear` hors `src/platform/logs/tauriLogs.ts` ; capabilities `logs*.json` exactes.
- Ni `src/db` ni `src/domain` ne sont touchés ; aucune dépendance npm ni cargo nouvelle (`serde_json`, `libc` sous `cfg(unix)` déjà présents).
- Fichiers : `src-tauri/src/applog.rs`, `lib.rs`, `build.rs`, `backup.rs`, `desktop.rs`, `sync/mod.rs`, `capabilities/logs.json`, `capabilities/logs-ios.json`, `tests/desktop/{applog,config,main}.rs`, `tests/fixtures/logs/sanitize-vectors.json`, `src/platform/logs/**`, `src/platform/desktop/log.ts`, `src/features/app/bootstrap.ts` (installation), `src/features/settings/{AboutSection.tsx,logs/**}`, `src/i18n/{fr,en}*`.
