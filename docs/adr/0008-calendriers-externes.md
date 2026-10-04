# ADR 0008 — Calendriers externes : Google, iCloud CalDAV, coffre, OAuth

- Statut : accepté (contrats posés ; implémentation par calendar-integration)
- Date : 2026-10-04
- Stories : K-01 à K-04 (M8, ordre 2) ; clôt avec elles ES-06 c.5-6, S-05 c.9-10, A-09 c.9-10

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

`token_ref` = `circletasks.calendar.<accountId>`, service `fr.circletasks.planner`. Le jeton Google est un JSON `{ refresh, access, expires_at }`. Un `token_ref` est **propre à l'appareil** (K-01 D1) : `calendar_account` se synchronise, le secret non ; sans entrée locale, le compte est « à reconnecter ».

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
