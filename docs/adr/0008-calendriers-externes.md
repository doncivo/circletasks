# ADR 0008 — Calendriers externes : Google, iCloud CalDAV, coffre, OAuth

- Statut : accepté (contrats posés ; implémentation par calendar-integration)
- Date : 2026-10-04
- Stories : K-01 à K-04 (M8, ordre 2) ; clôt avec elles ES-06 c.5-6, S-05 c.9-10, A-09 c.9-10
- Avenants de l'ordre 5 (2026-10-08, avant le code) : §9 K-TECH-01 (Google sur iPhone, plugin `web-auth`) ; §10 K-05 à K-07 (Rappels Apple, plugin `reminders`, migration 0018)

## Contexte

Lecture seule de Google Calendar (OAuth) et d'Apple Calendar (iCloud CalDAV, mot de passe d'application), même code sur PC et iPhone (PRD 7). Jetons et mots de passe dans le coffre système, jamais dans SQLite, les journaux ni l'état de l'interface (PRD 6 et 8, K-01 c.3, K-02 c.7). La WebView ne peut pas appeler iCloud : pas de CORS, méthodes `PROPFIND` / `REPORT`. Pas de Mac : rien n'est testable localement sur iPhone.

## Décision

### 1. Répartition Rust / TypeScript

- **Rust détient les secrets** (`src-tauri/src/calendars/`) : coffre, flux OAuth, ajout de `Authorization`, rafraîchissement du jeton Google (si expiré, ou une fois sur 401), liste d'hôtes (`hosts.rs`).
- **TypeScript analyse** : les fournisseurs (`src/features/calendars/providers/`, JSON Google, XML CalDAV, ICS) appellent `CalendarHttp.request` avec `auth: { kind, tokenRef }` ; la WebView n'envoie ni ne reçoit jamais de secret, sauf le mot de passe iCloud saisi, transmis une fois à `calendar_secret_set`. Cela remplace la mention « CalendarProvider (Rust) » des fiches K-01 / K-02 : un seul analyseur, testable en Vitest et Playwright.
- **Domaine** (`src/domain/calendarProvider.ts`, `calendarRefresh.ts`) : contrat `CalendarProvider` (`listCalendars`, `fetchEvents(calendarId, range, cursor)` → instances UTC ; curseur = ctag CalDAV, null chez Google, K-03 D1), `ProviderError`, fenêtre K-01 D3, normalisation vers `external_event`, règles de rafraîchissement, états de compte (`connected`, `reconnect-required`, `error`) et leur traduction en états A-09. Le type colonne `provider` est renommé `CalendarProviderKind`.
- **Plateforme** (`src/platform/calendars/`) : `SecretVault` (`set` / `has` / `delete`, **pas de `get` côté WebView** ; `get` n'existe qu'en Rust), `CalendarHttp`, `OAuthFlow`, `CalendarEndpoints`. Implémentation Tauri = commandes ci-dessous ; implémentation mémoire (dev, Vitest, Playwright) = coffre en mémoire + `fetch` vers les simulateurs.

### 2. Commandes Tauri (PC et iPhone, capability `calendars.json`)

| Commande | Entrée | Sortie | Rejets (code en chaîne) |
| --- | --- | --- | --- |
| `calendar_secret_set` | `tokenRef`, `secret` | `null` | `vault-unavailable` |
| `calendar_secret_exists` | `tokenRef` | `bool` | `vault-unavailable` |
| `calendar_secret_delete` | `tokenRef` | `null` (idempotent) | `vault-unavailable` |
| `calendar_oauth_google_authorize` | `tokenRef` | `null` (jetons au coffre) | `cancelled`, `state-mismatch`, `config-missing`, `network`, `timeout` |
| `calendar_oauth_google_revoke` | `tokenRef` | `null` (au mieux, puis effacement) | `vault-unavailable` |
| `calendar_http` | `CalendarHttpRequest` | `CalendarHttpResponse` (4xx/5xx = réponse) | `host-not-allowed`, `secret-missing`, `reauth-required`, `network`, `timeout` |

`token_ref` = `circletasks.calendar.<fournisseur>.<uuid>` (fournisseur `google` ou `icloud` ; format imposé par Rust, refus sinon ; la WebView ne peut pas écrire une référence `google`, seul le flux OAuth de Rust le fait), service `fr.circletasks.planner`. Le jeton Google est un JSON `{ refresh, access, expires_at }`. Un `token_ref` est **propre à l'appareil** (K-01 D1) : `calendar_account` se synchronise, le secret non ; sans entrée locale, le compte est « à reconnecter ».

### 3. Coffre : crate `keyring` 3

Features `windows-native` (Gestionnaire d'identification Windows) et `apple-native` (Trousseau, iOS compris, via `security-framework`, déjà présent dans Cargo.lock). Licence MIT / Apache-2.0, environ 100 Ko compilé, aucun plugin Swift. Écarté : `tauri-plugin-stronghold` (fichier chiffré local avec mot de passe à gérer : ce n'est pas le coffre système exigé par le PRD) et les plugins keyring communautaires (non maintenus par Tauri ; la crate suffit derrière nos commandes).

### 4. Réseau et CORS

- Toutes les requêtes Google et iCloud passent par `calendar_http` (reqwest, `rustls-tls`, déjà dans Cargo.lock via l'updater ; ajouté aussi pour iOS). **Pas de `tauri-plugin-http`** : il exposerait `fetch` à la WebView avec les jetons.
- Hôtes autorisés (HTTPS seul, redirections comprises) : `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `caldav.icloud.com`, `pNN-caldav.icloud.com` ; `http://127.0.0.1` seulement en build de debug (simulateurs). `Authorization` fourni par la WebView : refusé.
- **CSP inchangée** : `connect-src 'self' ipc: http://ipc.localhost` ; la WebView ne contacte aucun hôte externe (vérifié par `src/platform/calendars/consistency.test.ts`).

### 5. OAuth Google

- Portée `calendar.readonly` seule ; label du compte = id de l'agenda principal (adresse), sans portée `openid`.
- **PC** : PKCE S256 + `state`, serveur loopback `127.0.0.1:<port libre>` ouvert par Rust, navigateur système (crate opener côté Rust : aucune permission `opener:` pour la WebView), délai 5 min, échange du code par Rust. ID client « Application de bureau » injecté au build (`CT_GOOGLE_CLIENT_ID`, `option_env!`). Google exige souvent le `client_secret` d'un client de bureau, qu'il déclare non confidentiel : s'il le faut, il est injecté de la même façon (`CT_GOOGLE_CLIENT_SECRET`, secret GitHub), jamais commité.
- **iPhone** : plugin Swift `web-auth` (ASWebAuthenticationSession, `prefersEphemeralWebBrowserSession = false`), redirection `com.googleusercontent.apps.<id>:/oauth2redirect`, ID client « iOS » sans secret ; le plugin ne rend que l'URL de retour, Rust échange le code. Contrat seulement (K-01 D2) ; validé par le build CI et l'essai d'Ali.

### 6. iCloud CalDAV

Basic (identifiant Apple + mot de passe d'application), découverte depuis `caldav.icloud.com` (`current-user-principal` → `calendar-home-set` sur `pNN-caldav`), collections `VEVENT` seules, `REPORT calendar-query` avec `time-range` et `expand`, ctag par collection pour sauter les agendas inchangés.

### 7. Simulateurs (`tests/sim/`, TypeScript)

`startGoogleSim()` (OAuth PKCE, jeton, refresh, révocation, `calendarList`, `events.list` paginé, instances, journées entières, annulés) et `startCaldavSim()` (découverte, collections, ctag, REPORT, fixtures ICS : TZID, flottant, journée entière, annulé, série développée, sans titre, liste VTODO). Erreurs injectées par `failNext({ status, retryAfterSeconds, pathPrefix })`. Vitest : `startCalendarSims()` dans `beforeAll` ; Playwright : `globalSetup` sur ports fixes + `simulatorEndpoints()`. Écrits en TypeScript plutôt qu'en `.mjs` (fiches K-01 / K-02) : typés et lintés.

### 8. Lien tâche → événement (K-04)

`external_event.id` est **déterministe** : `externalEventRowId(compte, agenda, identifiant externe)`. L'upsert garde l'id (K-04 D4) et `task.external_event_id` (sans clé étrangère, K-04 D1) se résout sur tout appareil connecté au même compte ; sinon « Événement supprimé ».

## Conséquences

- Nouvelles dépendances cargo à ajouter par calendar-integration : `keyring` 3 (MIT/Apache-2.0), `reqwest` 0.13 `rustls-tls` (MIT/Apache-2.0, déjà compilé sur PC), `sha2` et `rand` (déjà dans Cargo.lock) pour PKCE. Aucune dépendance npm. `docs/licences.md` à compléter à l'ajout.
- Vérifié sous Windows : liste d'hôtes (`rustc --test`), contrats TS, simulateurs. La compilation iOS (keyring `apple-native`, reqwest) l'est par le runner macOS (ADR 0007).
- L'état de compte est local et non persistant : recalculé au démarrage (présence du secret).

## Ce qui attend Ali (jamais dans le dépôt)

1. Google Cloud : API Calendar activée, écran de consentement « Externe » en **Production**, IDs client « Application de bureau » et « iOS », remis par variables de build et secrets GitHub (`CT_GOOGLE_CLIENT_ID`, `CT_GOOGLE_IOS_CLIENT_ID`, éventuellement `CT_GOOGLE_CLIENT_SECRET`).
2. Identifiant Apple + mot de passe d'application (appleid.apple.com), saisis dans l'app uniquement.
3. Vérification réelle sur PC puis iPhone (parcours clé 8).

## Avenant (revue sécurité du lot K)

- `Authorization` lié à l'hôte : Bearer Google seulement vers `www.googleapis.com`, Basic seulement vers `caldav.icloud.com` et `pNN-caldav.icloud.com` ; contrôle refait à chaque redirection, en-tête retiré si la redirection change de fournisseur.
- En-têtes de la WebView : liste blanche (Depth, Content-Type, Accept, Prefer, If-None-Match, If-Match). Délai plafonné à 30 s, réponse à 10 Mo. Écoute OAuth : 5 connexions au plus en plus des 5 minutes.

## 9. Avenant K-TECH-01 : connexion Google sur iPhone (2026-10-08, avant le code)

Story technique K-TECH-01 (lot K, phase 2) ; solde K-01 critère 2 côté iPhone. Complète §5 (« iPhone ») sans changer le flux PC. Aucune migration, ni `src/domain` ni `src/db` touchés, aucune clé Info.plist, hôtes de §4 inchangés. Règle d'Ali : aucun échec silencieux.

### 9.1 Plugin `web-auth` (Swift, appelé par Rust seul)

- Crate `src-tauri/plugins/web-auth` sur le modèle de `folder-bookmark` (ADR 0011 §22) : `build.rs` avec `COMMANDS = []` (aucune permission `web-auth:` générée : la WebView ne peut rien appeler), `ios/Package.swift` (`.iOS(.v17)`), `ios/Sources/WebAuthPlugin.swift`, `src/lib.rs` (`ios_plugin_binding!`, `WebAuth::call` ; hors iOS `Err("unavailable")`). Dépendance de `src-tauri/Cargo.toml` **sous `[target.'cfg(target_os = "ios")'.dependencies]` seulement**, enregistrée dans le bloc `#[cfg(target_os = "ios")]` de `lib.rs`.
- **Une commande** : `authenticate`, entrée `{ url: string, callbackScheme: string }`, sortie `{ callbackUrl: string }`.
- Swift : `ASWebAuthenticationSession(url:callbackURLScheme:completionHandler:)`, `prefersEphemeralWebBrowserSession = false` (session Safari partagée, K-TECH-01 A3), `presentationContextProvider` = fenêtre active de la vue de l'app (`manager.viewController?.view.window`). Contrôles Swift (défense en profondeur) : `url` en `https` (ou `http://127.0.0.1` en debug), `callbackScheme` non vide, schéma de l'URL rendue égal à `callbackScheme`.
- **Codes d'erreur** (seuls rejets, `invoke.reject(code, code: code)`, aucun texte français en Swift) : `cancelled` (`ASWebAuthenticationSessionError.canceledLogin`) ; `unavailable` (aucune fenêtre, `start()` rend faux, `presentationContextNotProvided`) ; `failed` (toute autre erreur, entrée refusée, URL rendue d'un autre schéma). Swift ne journalise ni l'URL ni l'URL de retour.
- Fixture `tests/fixtures/calendars/web-auth-contract.json` : `{ plugin: "web-auth", commands: [{ name: "authenticate", swiftMethod: "authenticate", input: ["url", "callbackScheme"], output: ["callbackUrl"] }], errors: ["cancelled", "unavailable", "failed"] }`, contrôlée statiquement contre le Swift et `src-tauri/src/calendars/web_auth.rs` (K-TECH-01 c.3) et jouée par le faux Rust.

### 9.2 Rust (`src-tauri/src/calendars/web_auth.rs`, `google.rs`, `mod.rs`)

- **ID client iOS** : `IosClientConfig::from_environment()` lit `option_env!("CT_GOOGLE_IOS_CLIENT_ID")` (en debug, la variable d'exécution l'emporte, comme `ClientConfig`). Forme exigée `^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$` ; sinon `None` → rejet `config-missing`, rien n'est écrit. `Debug` masqué (« … »), jamais affiché ni journalisé.
- **Schéma dérivé** (fonction pure `ios_redirect(client_id) -> Option<(scheme, redirect_uri)>`, K-TECH-01 c.1) : `<n>-<h>.apps.googleusercontent.com` → `com.googleusercontent.apps.<n>-<h>` ; `redirect_uri = "<schéma>:/oauth2redirect"`.
- **Même client pour toute la vie du jeton** : sous `cfg(target_os = "ios")`, `ClientConfig::from_environment()` rend l'ID iOS et **aucun secret** ; `exchange_code`, `refresh_tokens` et `revoke` l'utilisent (un jeton de rafraîchissement n'est valable qu'avec le client qui l'a obtenu). Le `token_ref` étant propre à l'appareil (K-01 D1), aucun mélange PC / iPhone.
- **Flux** `authorize_ios(env, token_ref, runner: &dyn WebAuthRunner)` : `verifier` et `state` aléatoires (fonctions existantes), `build_auth_url` (portée `calendar.readonly` seule, `code_challenge` S256), URL contrôlée par `hosts::url_allowed`, runner appelé dans `spawn_blocking`, puis `parse_redirect(callback_url, redirect_uri, state)` : préfixe exact `<schéma>:/oauth2redirect`, **`state` comparé avant toute autre lecture** (différent ou absent → `state-mismatch`), `error=access_denied` → `cancelled`, autre `error` ou `code` absent → `web-auth-failed` ; échange du code **sans secret** ; `store_tokens`. Tout échec n'écrit rien (ni coffre, ni base).
- **Trait** : `pub trait WebAuthRunner: Send + Sync { fn authenticate(&self, url: &str, callback_scheme: &str) -> Result<String, WebAuthError>; }` avec `WebAuthError = Cancelled | Unavailable | Failed`. Réel : `PluginWebAuth` (iOS, `WebAuth::call`). Faux : `FakeWebAuth` (fermeture qui reçoit l'URL et rend une URL de retour construite, une erreur, ou suit l'autorisation du simulateur Google pour obtenir un vrai code).
- **Commande** `calendar_oauth_google_authorize` (entrée et sortie inchangées, capability `calendars.json` inchangée) : la variante `#[cfg(mobile)]` qui rejetait `unsupported` appelle désormais `authorize_ios`. Une session à la fois (garde atomique) : un second appel pendant une session rend `web-auth-unavailable`.
- **Rejets (ligne de §2 complétée)** : `cancelled`, `state-mismatch`, `config-missing`, `network`, `timeout` (PC seulement), **`web-auth-unavailable`**, **`web-auth-failed`** (iPhone). Aucun délai Rust sur iPhone : la feuille système se ferme par l'utilisateur (`cancelled`).
- **Journalisation** : codes seuls. Ni l'URL d'autorisation, ni l'URL de retour, ni le code, ni l'ID client dans un journal, une erreur rendue à la WebView ou l'état de l'interface (test sur les chaînes d'erreur et le journal technique, K-TECH-01 c.5).

### 9.3 TypeScript, CI, sécurité

- `src/platform/calendars` : plus de cas `unsupported` sur (`tauri`, `ios`) ; `web-auth-unavailable` et `web-auth-failed` ajoutés à l'union des rejets ; écran Agendas : « La connexion à Google n'a pas pu aboutir » + code + « Réessayer », état persistant jusqu'à la réussite ou l'annulation volontaire ; `config-missing` garde le texte de K-01. Textes dans `src/i18n`.
- Aucune clé Info.plist (le schéma intercepté par `ASWebAuthenticationSession` n'a pas à figurer dans `CFBundleURLTypes`) : `plist-contract.json` inchangé ; aucune capacité payante.
- `build-ios.yml` : contrôle « ID client Google iOS compilé » sur le binaire de l'IPA (motif chiffres + `-` + `.apps.googleusercontent.com`), résultat réduit à présent / absent ; absent → `::warning::` et ligne du résumé, jamais d'échec, jamais la valeur. `cargo tree --target aarch64-apple-ios` montre `tauri-plugin-web-auth`, la cible Windows non.
- Dépendances : aucune nouvelle (AuthenticationServices est un framework système).

## 10. Avenant K-05 à K-07 : Rappels Apple par EventKit (2026-10-08, avant le code)

Couvre K-05 (lecture), K-06 (écriture, création, suppression) et K-07 (arrivée sur PC). Décisions du 2026-10-07 et du 2026-10-08 (périmètre du product-owner) appliquées ; écarts en 10.9. Règle d'Ali : aucun échec silencieux.

### 10.1 Constat dans le code : l'identifiant du rappel existe déjà

Les fiches et la décision du 2026-10-07 prévoient une colonne nouvelle `task.apple_reminder_id`. Or la migration 0001 porte déjà, conformément au PRD (section 6 : « Les rappels Apple sont des tâches avec `source = apple_reminders` et l'identifiant du rappel dans `external_id` ») : `task.source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'apple_reminders'))` et `task.external_id TEXT`. Les deux sont **publiés** (catalogue `syncTables.ts` : `enum` et `text` 512 ; capturés par les déclencheurs de 0015), typés (`TaskSource`, invariant « `externalId` non nul seulement si `source = 'apple_reminders'` » de `src/domain/model/task.ts`) et nommés dans le journal des conflits (`sync.field.task.external_id` = « rappel Apple lié »).

**Décision** : **pas de colonne `apple_reminder_id`**. L'identifiant du rappel est `task.external_id`, l'origine `task.source = 'apple_reminders'` (et non `'apple'`). Une seconde colonne d'identifiant dupliquerait un champ publié et ajouterait un invariant à tenir entre deux appareils. Le sens de la décision d'Ali (des tâches portant un identifiant de rappel synchronisé, arrivant sur le PC par la synchro) est conservé ; partout où les fiches écrivent `apple_reminder_id`, lire `external_id`. La migration 0018 reste nécessaire : deux colonnes publiées que le PC exige (10.2) et les nouvelles clés de réglage partagées (10.3).

### 10.2 Données et migration `0018_apple_reminders`

**États d'une tâche** (fonction pure `appleLinkState(task)`, `src/domain/appleReminders.ts`) :

| État | `source` | `external_id` | `apple_list_id` |
| --- | --- | --- | --- |
| ordinaire | `local` | nul | nul |
| liée | `apple_reminders` | identifiant EventKit | liste du rappel |
| à créer dans Rappels (K-06) | `apple_reminders` | nul | liste de destination |
| détachée (K-07 c.8) | `local` | nul | dernière liste (non nulle) |

**Colonnes publiées ajoutées à `task`** (ajout : `sm` inchangé) :
- `apple_list_id TEXT` (catalogue `text`, 512, `conflictVisible: false`) : liste d'origine ou de destination, résolue en nom par `appleReminders.lists` sur tout appareil (« Source : Rappels · liste {nom} » sur le PC, K-05 c.13, K-07 c.7) ; gardée au détachement (marqueur « détachée » ; date affichée = heure du hlc du champ `external_id`, lue par le repository, sinon « Détachée de Rappels » sans date).
- `apple_recurring INTEGER NOT NULL DEFAULT 0 CHECK (apple_recurring IN (0, 1))` (catalogue `bool`, `conflictVisible: false`) : rappel récurrent dans Rappels ; sert le badge « Récurrent dans Rappels » et les refus de 10.6 sur **les deux** appareils.

**Table locale `apple_reminder_link`** (jamais publiée, absente du catalogue ; écrite par l'iPhone seul, vide sur PC) :

```sql
CREATE TABLE apple_reminder_link (
  task_id        TEXT PRIMARY KEY,   -- sans clé étrangère : la tâche peut être purgée avant la fin d'une suppression
  reminder_id    TEXT,               -- calendarItemIdentifier ; nul pendant une création
  external_ref   TEXT,               -- calendarItemExternalIdentifier (repli si l'identifiant local change)
  list_id        TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('linked', 'creating', 'deleting')),
  synced         TEXT,               -- empreinte JSON des valeurs au dernier passage réussi (10.5) ; nul = inconnue
  apple_modified TEXT,               -- lastModifiedDate vue au dernier passage (instant UTC)
  started_at     TEXT,               -- début d'une création ou d'une suppression (reprise)
  UNIQUE (reminder_id)
)
```

**Instructions de 0018** (une migration publiée ne change plus : somme de contrôle) :
1. `INSERT OR IGNORE INTO sync_guard (id) VALUES (1)` ;
2. les deux `ALTER TABLE task ADD COLUMN` ;
3. `DROP TRIGGER IF EXISTS` puis `CREATE TRIGGER` pour `sync_task_ai`, `sync_task_au`, `sync_settings_ai`, `sync_settings_au`, générés par une **copie figée du générateur de 0015 placée dans 0018** (`captureTriggersV18`, même texte) depuis `CAPTURE_TABLES_V18` (V15 où `task` reçoit `apple_list_id`, `apple_recurring` avant `created_at`, même ordre que le catalogue) et `SHARED_SETTING_KEYS_V18` (V15 + clés partagées de 10.3, triées). Le générateur de 0015 n'est **ni exporté ni partagé** : le modifier un jour changerait la somme de contrôle de 0015 et bloquerait le démarrage des bases existantes. Les déclencheurs des autres tables ne changent pas ;
4. `CREATE TABLE apple_reminder_link` ;
5. `DELETE FROM sync_guard`.

Vérifié dans le code : aucune ligne n'entre dans `sync_outbox` (garde, et `ADD COLUMN` n'exécute aucun déclencheur) ; le `sv` publié est la dernière migration (`bootstrap.ts` : `migrations.at(-1)?.version`), il passe de 17 à **18** sans autre code ; `sm` reste 1. Un appareil en 17 range `apple_list_id`, `apple_recurring` et les nouvelles clés dans `sync_unknown` (ADR 0011 §7.2 ; les clés respectent l'expression de §8), affiche « Mettez à jour l'app », et lit déjà `source` et `external_id` ; tout est réintégré après sa mise à jour.

**Tests** : `0015_sync_tables.test.ts` compare aujourd'hui `CAPTURE_TABLES_V15` et `SHARED_SETTING_KEYS_V15` au catalogue **courant** : ce contrôle passe à `0018_apple_reminders.test.ts` (V18 = catalogue) et le test de 0015 compare V15 à une copie littérale. Test « colonne locale ⇒ jamais dans `sync_outbox` » inchangé.

**Copies** (K-05 c.3) : duplication (T-12), occurrences d'une série (T-09), tâche depuis un événement (K-04), import (H-02) et saisie rapide ne copient jamais `source`, `external_id`, `apple_list_id`, `apple_recurring` : la copie est ordinaire. Seul le cas d'usage de création pose l'état « à créer » (10.7). Une tâche liée ou à créer ne reçoit pas de répétition CircleTasks (refus avec message).

**Sauvegardes** (`backup_triggers.rs`, ADR 0009 ; solde la dette « Lot P » des déclencheurs) : aujourd'hui `check_backup_file` refuse (`corrupt`) toute sauvegarde dont un déclencheur diffère de la référence ; une sauvegarde de version 17 serait donc refusée après 0018, contre K-05 c.4. Décision : chaque entrée de référence porte sa **version d'introduction**, et `SUPERSEDED_TRIGGERS` garde les corps remplacés avec leur intervalle (`since`, `until` exclu ; ici les 4 corps de la version 15, `until = 18`). `check_backup_file` lit d'abord la version de la sauvegarde puis exige, pour chaque déclencheur présent, le corps valable **à cette version** ; la préparation après restauration recrée ces mêmes corps (jamais un corps qui nomme une colonne absente de la sauvegarde), puis 0018 les remplace à l'ouverture. `triggers.test.ts` vérifie la référence contre une base migrée en 18 et les corps remplacés contre une base arrêtée en 17.

### 10.3 Réglages

| Clé | Portée | Valeur | Rôle |
| --- | --- | --- | --- |
| `appleReminders.lists` | partagée | `{ lists: [{ id, name, spaceId: SpaceId \| null, shown: boolean }] }`, 100 au plus | listes choisies, espace (ES-06 : prérempli Pro ; `shown` exige un espace), nom lisible sur le PC. Hors de `calendar_account`, dont le `CHECK (provider IN ('google', 'icloud'))` imposerait de refaire la table. |
| `appleReminders.create` | partagée | `{ bySpace: [{ spaceId, enabled, listId: string \| null }] }` | création dans Rappels par espace (K-06), désactivée par défaut ; `enabled` exige une liste `shown` de cet espace. |
| `appleReminders.lastPassAt` | partagée | `IsoDateTime \| null` | dernière lecture réussie ; au plus une écriture par 15 min (K-05 c.14, K-07). |
| `appleReminders.pending` | partagée | `{ count: number, at: IsoDateTime } \| null` | écritures dues vers Rappels (K-06 c.8, K-07 c.8) ; écrite seulement quand `count` change. |
| `appleReminders.status` | **locale** | `{ failure: { code, at } \| null, caps: [{ listId, total, imported }], held: { listId, count, at }[], unknown: number }` | échec persistant, plafonds atteints, suppressions retenues, liens inconnus sur cet appareil (10.6). Jamais de titre. |

Les quatre clés partagées entrent dans `SETTINGS_DEFINITIONS` (`shared`) et `SHARED_SETTING_KEYS_V18`. Le passage n'est jamais déclenché par une écriture de `appleReminders.*` (pas de boucle).

### 10.4 Plugin `reminders` (Swift, appelé par la WebView)

- Crate `src-tauri/plugins/reminders` (`.iOS(.v17)` ; app en iOS 18 minimum), sous `cfg(target_os = "ios")` dans `Cargo.toml` et `lib.rs`. Contrairement à `web-auth`, la WebView l'appelle (aucun secret ; la correspondance est en TypeScript, testable sous Windows) ; **seul `src/platform/reminders/tauriReminders.ts` nomme `plugin:reminders`** (test de cohérence).
- `build.rs` : `COMMANDS = ["status", "request_access", "lists", "fetch", "upsert", "set_completed", "delete", "register_listener", "remove_listener"]`. Méthodes Swift en lowerCamelCase (`status`, `requestAccess`, `lists`, `fetch`, `upsert`, `setCompleted`, `delete`) ; la fixture porte les deux formes. `checkPermissions` / `requestPermissions` de la classe `Plugin` ne sont pas utilisés.
- Capability `src-tauri/capabilities/reminders-ios.json`, `platforms: ["iOS"]`, fenêtre `main`, **liste exacte** (test `tests/desktop/config.rs`) : `reminders:allow-status`, `reminders:allow-request-access`, `reminders:allow-lists`, `reminders:allow-fetch`, `reminders:allow-upsert`, `reminders:allow-set-completed`, `reminders:allow-delete`, `reminders:allow-register-listener`, `reminders:allow-remove-listener`. Aucune capability Windows ne contient `reminders:`.
- Info.plist : `NSRemindersFullAccessUsageDescription`, texte français dans `src-tauri/Info.ios.plist` (proposition : « CircleTasks lit les listes Rappels que vous choisissez pour les afficher comme tâches, et y reporte vos changements. ») ; entrée `"reminders": { "story": "K-05", "usageDescriptions": ["NSRemindersFullAccessUsageDescription"] }` dans `scripts/ios/plist-contract.json`, avec son test. Pas de `NSRemindersUsageDescription` (iOS 18 minimum). EventKit ne demande aucune capacité payante.

**Contrat** (`src/platform/reminders/types.ts` ; fixture `tests/fixtures/calendars/reminders-contract.json`) :

```ts
type RemindersAccess = 'not-determined' | 'denied' | 'restricted' | 'full';   // writeOnly (sans objet pour les rappels) → 'denied'
interface ReminderList { readonly id: string; readonly name: string; readonly writable: boolean }   // calendarIdentifier, title, allowsContentModifications
interface ReminderDue { readonly date: LocalDate; readonly time: LocalTime | null }                 // heure murale du fuseau courant (Swift convertit un dueDateComponents avec fuseau)
interface ReminderItem {
  readonly id: string; readonly externalRef: string | null; readonly listId: string;
  readonly title: string; readonly due: ReminderDue | null;
  readonly completed: boolean; readonly completedAt: IsoDateTime | null;
  readonly recurring: boolean;                                                 // hasRecurrenceRules
  readonly modifiedAt: IsoDateTime | null; readonly createdAt: IsoDateTime | null;
}
interface RemindersPlatform {
  status(): Promise<RemindersAccess>;
  /** requestFullAccessToReminders ; seulement sur le geste « Autoriser l'accès aux Rappels », jamais au démarrage. */
  requestAccess(): Promise<RemindersAccess>;
  lists(): Promise<readonly ReminderList[]>;
  /** Non terminés des listes (échéance croissante, sans échéance ensuite, puis création), coupés à limitPerList ; plus les éléments demandés par identifiant, terminés compris. */
  fetch(input: { listIds: readonly string[]; limitPerList: number; ids: readonly { id: string; externalRef: string | null }[] }): Promise<{
    lists: readonly { listId: string; total: number; items: readonly ReminderItem[] }[];
    byId: readonly ReminderItem[]; missing: readonly string[]; missingLists: readonly string[];
  }>;
  upsert(input: { id: string | null; listId: string; title: string; due: ReminderDue | null; completed: boolean; completedAt: IsoDateTime | null }): Promise<ReminderItem>;
  setCompleted(input: { id: string; completed: boolean; completedAt: IsoDateTime | null }): Promise<ReminderItem>;
  delete(input: { id: string }): Promise<void>;                                // idempotent : déjà absent = succès
  onChanged(listener: () => void): Promise<() => void>;                        // EKEventStoreChanged, sans contenu
}
```

- **Codes d'erreur** (seuls rejets, aucun texte français en Swift ; un rejet inconnu est ramené à `store-unavailable` par l'adaptateur) : `access-denied`, `store-unavailable`, `read-failed`, `write-failed`, `not-found`, `list-not-found`, `read-only-list`, `recurring-refused` (écriture sur un rappel récurrent : Swift la refuse aussi), `invalid-input`.
- **Échéance écrite** : date seule → `dueDateComponents` {année, mois, jour} sans fuseau ; date et heure → avec heure, minute et `TimeZone.current` ; aucune → `nil`. Les alarmes ne sont ni lues ni créées ; une alarme absolue égale à l'ancienne échéance est déplacée avec elle (retirée si l'échéance l'est), pour que Rappels ne sonne pas à l'ancienne heure (à vérifier sur l'appareil, K-05 A5). Notes, priorité, drapeau, sous-tâches, lieu : jamais touchés (D1).
- `upsert` et `setCompleted` rendent l'élément **relu après enregistrement** (`modifiedAt` compris) : base de l'anti-boucle (10.5).
- Implémentations : `tauriReminders.ts` (iPhone), `fakeReminders.ts` sur `tests/sim/reminders-sim.ts` (magasin en mémoire ; injecté en `__ctReminders` en développement seulement), `unavailableReminders.ts` (PC et navigateur : aucun appel). Résolveur `openRemindersPlatform(runtime, os)`.

### 10.5 Correspondance, empreinte, conflits, anti-boucle

Module pur `src/domain/appleReminders.ts`. Valeurs comparées : `{ title, date, time, completed, doneAt }` de la tâche ; `fromApple(item)` les calcule côté Rappels (titre tronqué à la limite du catalogue ; titre vide → texte i18n « Rappel sans titre » ; sans échéance → `someday = true`, `date = time = null` ; avec échéance → `someday = false`). **Empreinte** `synced` = ces valeurs au dernier passage réussi (égales des deux côtés après écriture).

Pour chaque champ `f` d'une tâche liée :
- `appleChanged = fromApple(item).f ≠ synced.f` ; `localChanged = task.f ≠ synced.f`, **sauf** la date d'une tâche `carried_over` : le report T-06 n'est jamais renvoyé (D5), la date reportée reste locale tant que Rappels ne change pas l'échéance ; si Rappels la change, Rappels gagne et `carried_over` repasse à 0 ;
- un seul côté a changé : il gagne ; les deux avec la même valeur : rien à écrire, empreinte mise à jour ;
- **les deux avec des valeurs différentes : conflit**. Gagne le plus récent entre `item.modifiedAt` (date de l'élément entier) et l'heure physique du hlc du champ local (`sync_field_clock` du champ, sinon `'*'`, sinon hlc de la ligne) ; à égalité, Rappels. La valeur perdue va dans `conflict_log` (table `task`, champ `title`, `date`, `time` ou `status`) ; pour le côté Rappels, `*_device = 'apple-reminders'` et `*_hlc` = hlc **synthétique** `<modifiedAt en ms sur 15 chiffres>-0000-00000000-0000-4000-8000-0000000000ae` (UUID v4 réservé `APPLE_REMINDERS_PSEUDO_DEVICE`, conforme à l'expression de l'ADR 0005), affiché « Rappels Apple » par l'écran de Y-04. « Restaurer » reste une écriture locale ordinaire, envoyée vers Rappels au passage suivant si elle remplace la valeur de Rappels.
- Empreinte inconnue (`synced` nul : réinstallation, restauration, lien reconstruit pour une tâche reçue par la synchro) : chaque champ différent est traité comme un conflit.

**Anti-boucle** : après une écriture vers Rappels, `synced` et `apple_modified` sont mis à jour avec l'élément **relu** rendu par le plugin ; une écriture vers la tâche (transaction tâche + lien) met `synced` aux valeurs écrites. Le passage suivant ne voit aucune différence (`{ envoyées: 0, reçues: 0 }`) ; l'événement `changed` provoqué par nos propres écritures donne un passage vide. Un arrêt entre l'écriture Apple et la mise à jour du lien laisse deux côtés égaux : rien n'est réécrit, l'empreinte est rattrapée.

**Écritures vers la tâche** par les cas d'usage existants seulement (terminer / rouvrir T-05, modifier T-04, corbeille T-08, `WriteStamper`) : publiées, donc visibles sur le PC (K-07) ; aucun SQL dans la feature ; le passage ne pose **pas** `sync_guard`.

### 10.6 Import, suppression, récurrents, plafond, cas limites

- **Import** (K-05) : rappels **non terminés** des listes `shown` (avec espace). Tâche et lien créés dans **une** transaction, idempotente par `UNIQUE (reminder_id)` et par la recherche d'une tâche vivante de même `external_id` (lien reconstruit plutôt que doublon). Espace = celui de la liste à l'import, puis propre à CircleTasks (D3). Aucune ligne `reminder` CircleTasks (D6).
- **Plafond** : 500 éléments par liste visible et par passage, dans l'ordre du plugin ; les tâches déjà liées restent suivies au-delà (lecture par identifiant). Au-delà : `caps` de `appleReminders.status`, message persistant « 500 rappels sur 740 importés » dans l'écran Agendas.
- **Suivi borné** : sont relus par identifiant les liens des tâches à faire, terminées depuis moins de 30 jours, ou modifiées localement depuis le dernier passage ; un rappel ancien rouvert dans Rappels revient par la lecture des non terminés.
- **Rappel absent** (ni parmi les non terminés, ni par `id`, ni par `externalRef`, lecture **réussie** avec accès `full`) : corbeille **et** détachement (`source = 'local'`, `external_id = null`) dans la même écriture, message « {n} rappel(s) supprimé(s) dans Rappels » ; si la tâche avait des changements locaux non envoyés, conflit sur `deleted_at` (la suppression gagne, la tâche reste restaurable 30 jours, ADR 0011 §4.2). Restaurée, c'est une tâche ordinaire : aucune boucle de suppression.
- **Jamais de suppression** sur un échec de lecture, un accès autre que `full`, une liste absente (`missingLists` : état « Liste {nom} introuvable », tâches intactes et toujours liées), ni pour une tâche sans lien **sur cet appareil** (identifiant inconnu ici : compté dans `unknown`, visible, aucune écriture).
- **Garde de suppression massive** : si un passage devait supprimer plus de `max(10, 25 %)` des tâches liées d'une liste, rien n'est supprimé ; `held` est posé et l'écran Agendas demande « {n} rappels sont absents de Rappels. Supprimer les tâches liées ? » (« Supprimer » / « Garder et détacher »). Rien ne disparaît sans geste.
- **Liste décochée** (ou espace retiré) : tâches liées **non modifiées localement** depuis le dernier passage → corbeille + détachement ; les autres → détachées et gardées ; message visible. **Rappel déplacé** : suivi si la nouvelle liste est `shown` (`apple_list_id` mis à jour), sinon règle de la liste décochée.
- **Rappels récurrents** (`apple_recurring = 1`) : importés à l'échéance courante ; **aucune écriture vers Rappels** (titre, date, achèvement, suppression). Dans CircleTasks, sur PC comme sur iPhone, case, titre, date, heure et suppression d'une tâche liée récurrente sont refusés avec « Modifiez ce rappel récurrent dans Rappels ». Une valeur locale arrivée malgré tout (version plus ancienne, conflit restauré) est remplacée par celle de Rappels et inscrite dans `conflict_log`. Quand Rappels passe à l'échéance suivante, la tâche suit.
- **Suppression dans CircleTasks** (D2) : confirmation « Supprimer aussi dans Rappels ? » ; au passage, lien `deleting` (`started_at`), `delete` (idempotent), détachement de la tâche, retrait du lien. Annulée dans les 5 s (T-13) : rien n'est envoyé (10.8). Tâche purgée avant l'envoi : le lien `deleting` suffit à finir.
- **Liste en lecture seule** (`writable` faux) : écritures refusées `read-only-list`, comptées en attente et visibles ; la lecture continue.

### 10.7 Création dans Rappels (K-06)

- Seul `createTask` (saisie, capture, Q-01) lit `appleReminders.create` pour l'espace de la nouvelle tâche ; activé avec une liste : la tâche naît « à créer » (`source = 'apple_reminders'`, `external_id = null`, `apple_list_id = liste`), sur PC comme sur iPhone. Aucune comparaison de dates : l'état est posé à la création, les tâches existantes à l'activation ne sont jamais envoyées. Réglage désactivé (défaut) : aucun appel d'écriture.
- Au passage de l'iPhone : lien `creating` (`started_at`) écrit **avant** `upsert({ id: null })` ; succès → `external_id` (tâche, publié) et lien `linked` dans une transaction. Reprise après un arrêt (lien `creating` sans identifiant) : élément de même titre et même échéance créé après `started_at` dans la liste ; un seul → adopté ; aucun → nouvelle création ; plusieurs → le plus ancien adopté, les autres signalés (jamais supprimés en silence).
- Tâche à créer supprimée avant l'envoi : rien n'est créé, état ordinaire. Terminée avant l'envoi : créée terminée. Liste de destination disparue ou décochée : réglage désactivé avec message (K-06 c.6), tâches à créer remises à l'état ordinaire avec message.

### 10.8 Passages, coordination, échecs visibles

- Coordinateur `src/features/calendars/appleReminders/remindersRunner.ts` sur le modèle de `NotificationRunner` (ADR 0012 N1.3) : au plus un passage en cours et un en attente ; une rafale de 20 déclencheurs donne au plus deux passages. Deux sortes : **`full`** (ouverture, reprise, `changed`, synchro reçue touchant `task` ou `settings`, passage en arrière-plan) et **`push`** (écriture locale d'une tâche liée ou à créer : différences locales seulement, relues par identifiant, sans lecture des listes), lancé **6 s** après l'écriture pour laisser passer l'annulation de 5 s (T-13). Un `full` en attente absorbe un `push`.
- Arrière-plan iPhone (Y-IOS-01) : `notifications.request('hide')`, puis passage `full` borné à **8 s**, puis cycle de synchro ; un passage coupé reprend à l'ouverture suivante sans doublon (liens écrits avant toute création, transactions par paquets de 100 tâches).
- **PC** : aucun passage, aucun appel de plugin ; écran Agendas en lecture seule (« Se règle sur l'iPhone »), heure `lastPassAt`, compteur `pending`, mention « Sera envoyée vers Rappels au prochain passage de l'iPhone » si la tâche liée a été modifiée après `lastPassAt` (K-07 D2), avertissement de fraîcheur au-delà de 24 h (K-07 D1, modèle N-07). Le PC n'envoie aucune notification (N-01 c.13 inchangé).
- **Aucun échec silencieux** : tout rejet du plugin et toute exception d'un passage sont écrits dans `appleReminders.status.failure` (code, heure ; jamais de titre), affichés dans l'écran Agendas et par un état A-09 **`appleRemindersTrouble`** (« Les Rappels Apple n'ont pas pu être lus » ou « {n} modification(s) n'ont pas pu être envoyées vers Rappels », « Voir »), inséré dans `APP_STATUS_PRIORITY` juste après `remindersTrouble` ; effacés au premier passage réussi (ou quand plus rien n'est dû). Accès refusé ou révoqué : état persistant + bandeau, aucune lecture, aucune suppression ; tâches importées visibles. Journal technique : codes et nombres seulement.
- **Écritures dues** : pas de file séparée. Elles sont **dérivées** à chaque passage (différences tâche / empreinte, liens `creating` et `deleting`, tâches à créer) : elles survivent au redémarrage puisqu'elles sont dans les données, ne débordent pas et ne s'écartent jamais. `pending.count` en est le nombre.

### 10.9 Écarts avec les fiches et décisions (à reporter par le product-owner ; à valider par Ali en fin d'ordre)

1. **`apple_reminder_id` remplacé par `external_id`** existant (10.1), `source` « apple » par `apple_reminders` (K-05 c.9) ; 0018 ajoute à la place `apple_list_id` et `apple_recurring`, publiées. Écart de nom à la décision du 2026-10-07, pas de sens.
2. **Journal des conflits « visible des deux côtés »** (K-07 c.4) : `conflict_log` est local (ADR 0011 §4.3) et seuls les passages de l'iPhone détectent un conflit avec Rappels ; le PC voit le résultat, pas la ligne du journal. Publier le journal changerait l'ADR 0011 : non retenu.
3. **File de 100 écritures avec abandon de la plus ancienne** (K-06 c.8) : remplacée par les écritures dérivées (10.8), sans abandon possible.
4. **Récurrents** : « terminés dans Rappels seulement » (décision du 2026-10-08) étendu au titre, à la date et à la suppression (« aucune écriture sur une série »), refusés dans l'interface des deux appareils.
5. **Passage `push` 6 s après une écriture locale** : précise « immédiat sur iPhone » (K-06 c.1) pour respecter l'annulation de 5 s.
6. **Garde de suppression massive** (10.6) : ajout de l'architecte (Rappels peut présenter une liste vide pendant une resynchronisation iCloud).
7. **Nom du test du catalogue** : les fiches citent `syncCatalogue.test.ts` ; la copie figée est contrôlée par `src/db/migrations/0015_sync_tables.test.ts` (et le catalogue par `src/domain/sync/catalogue.test.ts`).
8. **Sauvegarde de version 17** (K-05 c.4) : impossible sans toucher `backup_triggers.rs` et `backup.rs` (dette « Lot P », soldée en 10.2).

### 10.10 Fichiers impactés

`src/db/migrations/0018_apple_reminders.ts` (+ test sur base de version 17 peuplée), `index.ts`, `0015_sync_tables.test.ts` ; `src/domain/sync/syncTables.ts` ; `src/domain/model/{task,settings}.ts` ; `src/domain/appleReminders.ts` (nouveau, pur) ; `src/domain/appStatus.ts` ; `src/db/repositories/appleReminderLinkRepository.ts` et `sql/appleReminderLinks.ts` (nouveaux), `taskRepository` (colonnes, heure du champ `external_id`), `syncConflictRepository` (conflit avec Rappels) ; `src/platform/reminders/*` (nouveau) ; `src/features/calendars/appleReminders/*` (passage, coordinateur, état), `CalendarsScreen.tsx`, fiche de tâche, badges, cas d'usage de création, duplication, séries, suppression ; écran des conflits (pseudo-appareil) ; `src/i18n/{fr,en}*` (dont `syncField` des deux colonnes) ; `src-tauri/plugins/{web-auth,reminders}/` (nouveaux) ; `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `capabilities/reminders-ios.json`, `tests/desktop/config.rs` ; `src-tauri/src/calendars/{mod,google,web_auth}.rs` ; `src-tauri/src/{backup_triggers,backup}.rs`, `src/platform/backup/triggers.test.ts` ; `src-tauri/Info.ios.plist`, `scripts/ios/plist-contract.json` ; `tests/fixtures/calendars/{web-auth,reminders}-contract.json`, `tests/sim/reminders-sim.ts` ; `.github/workflows/build-ios.yml`. Aucune dépendance npm ni cargo nouvelle.
