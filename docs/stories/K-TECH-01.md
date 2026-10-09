# K-TECH-01 — Connexion Google sur iPhone : plugin `web-auth` (complément iPhone de K-01)

Module : M8 Calendriers · Ordre de construction : 5 (lot K, phase 2, **premier** du lot : il ne touche ni `src/db` ni `src/domain`) · Agents : **calendar-integration** (Rust, TypeScript) et **ios-mobile** (Swift du plugin, capability, CI) · Relectures : qa-test, code-reviewer, **security-privacy (obligatoire : jetons OAuth, schéma de redirection)** · Statut : code livré sur lot-k-ios (vérification sur l’appareil en attente, A1 à A5)
Story technique, choisie plutôt qu'un critère ajouté à K-01 : K-01 est « fait » (PC validé par Ali le 2026-10-08), sa fiche promettait « iPhone avec le plugin web-auth au lot des calendriers », et le plugin a son propre contrat, sa propre vérification CI et sa propre vérification sur l'appareil. K-01 critère 2 (« iPhone : session d'authentification web ») est soldé par cette story. Écart au backlog à signaler à Ali : une ligne de plus, aucune fonction nouvelle du PRD.
Dépend de : K-01 (flux OAuth PKCE PC, simulateur Google), I-01 (chaîne `build-ios.yml` par branche et contrat Info.plist). Le secret GitHub `CT_GOOGLE_IOS_CLIENT_ID` est déjà branché dans `build-ios.yml` et déclaré dans `BUILD_SECRETS` de `src-tauri/build.rs`.

## Rappel

K-01 critère 2 : « iPhone : session d'authentification web » ; ADR 0008 §5 : plugin Swift `web-auth` (ASWebAuthenticationSession, `prefersEphemeralWebBrowserSession = false`), redirection `com.googleusercontent.apps.<id>:/oauth2redirect`, ID client « iOS » sans secret, le plugin ne rend que l'URL de retour, Rust échange le code. Aujourd'hui `calendar_oauth_google_authorize` rejette `unsupported` sur iOS (`src-tauri/src/calendars/mod.rs`, vers la ligne 132).

## À lire avant le code

`docs/adr/0008-calendriers-externes.md` (§1, §2, §4, §5, avenant sécurité), `docs/stories/K-01.md` (section « Ce qu'Ali doit fournir »), `src-tauri/src/calendars/{mod,google,http,hosts}.rs`, `src-tauri/build.rs`, `src-tauri/plugins/README.md` et `folder-bookmark` (modèle de plugin appelé par Rust seul, contrat vérifié statiquement), `tests/fixtures/sync/folder-bookmark-contract.json`, `src/platform/calendars/*`, `src/features/calendars/CalendarsScreen.tsx`, `tests/sim/google-sim.ts`, `scripts/ios/plist-contract.json`, `.github/workflows/build-ios.yml`.

## ADR requis avant le code

**Avenant à l'ADR 0008, §9 « Connexion Google sur iPhone », par l'architecte, avant la première ligne.** Contenu attendu :
1. Contrat du plugin `web-auth` : une commande `authenticate({ url, callbackScheme }) -> { callbackUrl }`, codes d'erreur `cancelled`, `unavailable`, `failed` (aucun texte français en Swift), ancre de présentation (fenêtre active), `prefersEphemeralWebBrowserSession = false`, appelée par Rust seul (aucune permission pour la WebView, comme `folder-bookmark`) ; fixture de contrat `tests/fixtures/calendars/web-auth-contract.json` contrôlée contre le Swift et Rust.
2. Rust : lecture `option_env!("CT_GOOGLE_IOS_CLIENT_ID")`, schéma de redirection dérivé de l'ID (`<n>-<h>.apps.googleusercontent.com` donne `com.googleusercontent.apps.<n>-<h>`), PKCE S256 et `state` vérifiés comme sur PC, échange du code sans secret, trait `WebAuthRunner` (réel iOS, faux de test), `config-missing` si l'ID manque, `state-mismatch` si l'URL de retour est falsifiée ; hôtes de l'ADR 0008 §4 inchangés.
3. CI et sécurité : entrée cargo sous `cfg(target_os = "ios")`, aucune clé Info.plist (le schéma intercepté par la session n'est pas enregistré), contrôle de l'IPA qui signale (sans échec ni affichage de la valeur) l'absence de l'ID compilé, sans journaliser l'URL de retour ni le code.

## Critères testables sans Mac

Légende : **[R]** cargo test, **[U]** Vitest, **[S]** contrôle statique, **[E]** Playwright projet `iphone`, **[CI]** `build-ios.yml` sur la branche du lot.

1. **[R]** **Étant donné** `CT_GOOGLE_IOS_CLIENT_ID` = `123-abc.apps.googleusercontent.com`, **alors** le schéma de redirection vaut `com.googleusercontent.apps.123-abc`, l'URL d'autorisation contient `code_challenge` (S256), `state` aléatoire et la seule portée `calendar.readonly` ; un ID mal formé ou absent donne `config-missing`, rien n'est enregistré.
2. **[R]** **Quand** le faux `WebAuthRunner` rend l'URL de retour avec le bon `state` et un code (jeu avec le simulateur Google local), **alors** Rust échange le code **sans secret**, range les jetons dans le coffre (`token_ref` seul en base) et rend `null` ; un `state` différent donne `state-mismatch` et n'écrit rien ; `cancelled` donne « Connexion annulée » sans écriture ; `failed` et `unavailable` donnent un message distinct (voir critère 6).
3. **[S]** **Alors** un test lit les sources Swift et Rust : la commande déclarée existe des deux côtés avec les mêmes champs, chaque code d'erreur Swift est connu de Rust, **aucune chaîne française en Swift**, aucune permission `web-auth:` dans les capabilities (Rust seul appelle), le crate n'est déclaré que sous `cfg(target_os = "ios")`.
4. **[U]** **Alors** sur (`tauri`, `ios`), le bouton « Google » de l'écran Agendas est actif (il ne l'est plus par `unsupported`) ; sur (`tauri`, `windows`) le flux PC est inchangé (tests K-01 verts, non modifiés).
5. **[R]** **Alors** ni l'URL de retour, ni le code, ni l'ID client ne figurent dans les journaux, les erreurs rendues à la WebView ou l'état de l'interface (test sur les messages d'erreur et sur le journal technique).
6. **Aucun échec silencieux.** **Étant donné** un échec `failed` ou `unavailable`, **alors** l'écran Agendas affiche un message persistant « La connexion à Google n'a pas pu aboutir » avec le code d'échec et « Réessayer » ; `config-missing` affiche « Google n'est pas configuré dans cette version de l'application » (texte K-01) ; l'état disparaît à la connexion réussie ou à l'annulation volontaire.
7. **[E]** Projet `iphone`, `WebAuthRunner` et simulateur Google injectés (développement seulement) : connexion, liste des agendas, choix de l'espace, événement dans la Semaine ; annulation ; `state` falsifié ; jeton révoqué donnant « Agenda {nom} déconnecté » + « Reconnecter » qui relance le flux. Projet `pc` inchangé.
8. **[CI]** `build-ios.yml` vert sur la branche du lot ; `cargo tree --target aarch64-apple-ios` montre le crate `web-auth`, la cible Windows ne le montre pas ; le contrat Info.plist passe **sans nouvelle entrée** ; si l'ID client n'est pas dans l'IPA, le résumé du run le signale en avertissement.

## Critères seulement vérifiables sur l'appareil (reportés dans `_checklist-ordre-5.md`)

- A1. Prérequis d'Ali : ID client Google de type « iOS » avec l'identifiant de bundle `fr.circletasks.planner`, secret GitHub `CT_GOOGLE_IOS_CLIENT_ID`. Réglages > Agendas > Google : la feuille système s'ouvre, consentement, retour dans l'app, compte et agendas listés, événement visible dans la Semaine.
- A2. Fermer la feuille avant la fin : « Connexion annulée », aucun compte créé.
- A3. Compte Google déjà connecté dans Safari : session partagée (non éphémère), consentement en un geste.
- A4. Révoquer l'accès sur myaccount.google.com : « Agenda … déconnecté » + « Reconnecter » sur l'iPhone.
- A5. Compte créé sur le PC : sur l'iPhone, « Déconnecté » avec « Reconnecter » (K-01 D1), reconnexion réussie.

## Hors de cette story

Lecture d'autres fournisseurs, écriture vers Google, Rappels Apple (K-05 à K-07), rafraîchissement périodique en arrière-plan (K-03 inchangé).

## Ordre des sous-tâches

1. architect : avenant ADR 0008 §9 (en parallèle de l'avenant §10 des Rappels Apple).
2. ios-mobile : crate `src-tauri/plugins/web-auth` (Swift, `build.rs`), fixture de contrat, entrée cargo et enregistrement sous `cfg(target_os = "ios")`.
3. calendar-integration : `WebAuthRunner`, flux iOS dans `calendars/google.rs`, remplacement du rejet `unsupported`, messages i18n.
4. UI : états d'échec de l'écran Agendas ; e2e `iphone` ; `build-ios.yml` sur la branche ; qa-test, code-reviewer, security-privacy.
5. Checklist d'appareil.
