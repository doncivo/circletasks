# ADR 0013 — iPhone : gestes, verrouillage et expiration

- Statut : accepté (contrat ; implémentation par ios-mobile, tasks-planning, quick-capture, settings-personalization, notifications, domain-logic pour M0)
- Date : 2026-10-08
- Stories : A-07 (gestes, section 1), I-03 (Face ID, section 2), I-02 (expiration de la signature, section 3), Q-05 (capture iPhone, section 4) ; lot M, ordre 5, phase 2
- Complète : ADR 0007 (avenants POC-01 et I-01 : build sans signature, contrat Info.plist), ADR 0012 (avenant N1 : plage réservée, pont `createIosNotificationBridge`, `reservedCount()`, `replanNotifications`), ADR 0011 §22 et §23 (folder-bookmark, scan du QR)
- Sources relues le 2026-10-08 : crates `tauri-plugin-haptics` **2.4.1** et `tauri-plugin-biometric` **2.4.1** (`src/*.rs`, `build.rs`, `ios/Sources/*.swift`, `permissions/`, `Cargo.toml`, `CHANGELOG.md`), `tauri` 2.12.1 (`mobile/ios-api/Sources/Tauri/Tauri.swift`, `src/plugin/mobile.rs`), `src-tauri/{Cargo.toml,build.rs,src/lib.rs,capabilities,tests/desktop/config.rs}`, `scripts/ios/plist-contract.json`, `src/App.tsx`, `src/features/app/{bootstrap,startup}.ts`, `src/features/tasks/TaskCreateSheet.tsx`, `src/ui/{Fab,Sheet,useFocusTrap,useSwipe,useZoneDrag,dragPrimitive}.ts(x)`, `src/domain/{appStatus,notificationInstant}.ts`, `src/domain/model/settings.ts`, fiches A-07, Q-05, I-03, I-02, `docs/decisions.md` (2026-10-07, 2026-10-08)

## Contexte

Le lot M ajoute à l'iPhone quatre comportements sans écran nouveau (sauf l'écran de verrou, composé avec les composants existants) : gestes de ligne avec retour haptique (A-07), verrouillage par Face ID ou code (I-03), alerte 24 h avant l'expiration hebdomadaire de la signature SideStore (I-02), capture rapide avec clavier immédiat (Q-05). Contraintes : pas de Mac (CI seule), Apple ID gratuit (aucun droit payant, ADR 0007), aucun échec silencieux (règle d'Ali), le PC ne change pas.

## Constats de lecture

1. **Tauri 2.12.1 appelle les méthodes Swift des plugins sur une file série d'arrière-plan** (`PluginManager.invoke` → `ipcDispatchQueue.async`), jamais sur le fil principal.
2. **`tauri-plugin-haptics` 2.4.1** : `impactFeedback`, `notificationFeedback`, `selectionFeedback` créent et déclenchent `UI*FeedbackGenerator` **sur cette file d'arrière-plan** (constat 1) : usage d'UIKit hors du fil principal, comportement non garanti (vibration perdue ou retardée, avertissement du Main Thread Checker). `vibrate` crée un `CHHapticEngine` jamais retenu. Aucune clé Info.plist, aucun droit, licence MIT OR Apache-2.0, MSRV 1.90, édition 2024, dépend de `tauri` 2.12 et `tauri-plugin` 2.7.1 (déjà présents). **Défaut retenu** : la fiche A-07 prévoit alors le plugin maison (section 1.1).
3. **`tauri-plugin-biometric` 2.4.1** : aucune commande Rust (les appels JS `plugin:biometric|status` et `|authenticate` vont directement au Swift) ; permissions `allow-status`, `allow-authenticate` (la permission `default` accorde les deux : non utilisée). Licence MIT OR Apache-2.0, MSRV 1.90 ; seule dépendance transitive nouvelle pour le plugin, `serde_repr` 0.1.21, est **déjà** dans `Cargo.lock`. Crate entière sous `#![cfg(mobile)]`.
4. **`status` est calculé une seule fois**, dans `load(webview:)` au démarrage du processus (`canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`), puis rendu tel quel : une suppression du code ou de Face ID pendant que l'app vit n'y apparaît pas. Il ne dit rien du code de l'iPhone, sauf par `errorCode = "passcodeNotSet"`.
5. **`authenticate`** crée un `LAContext` neuf à chaque appel, `touchIDAuthenticationAllowableReuseDuration = 0`, politique `.deviceOwnerAuthentication` si `allowDeviceCredential` (Face ID puis code de l'iPhone), sinon biométrie seule. Rejets : `invoke.reject(message, code)` avec `userCancel`, `systemCancel`, `appCancel`, `authenticationFailed`, `passcodeNotSet`, `biometryLockout`, `biometryNotAvailable`, `biometryNotEnrolled`, `invalidContext`, `notInteractive`, `userFallback` ; **un `LAError` absent de la table rend un code nul**. Une raison vide fait lever `evaluatePolicy` (exception Objective-C, arrêt de l'app).
6. Face ID **sans** `NSFaceIDUsageDescription` : `status` rend indisponible (`biometryNotAvailable`) ; la clé est donc obligatoire (contrat Info.plist). Aucun droit (entitlement) n'est nécessaire, ce qui est compatible avec l'IPA non signée (ADR 0007, avenant POC-01).
7. Le démarrage actuel (`App.tsx`) ne rend **la coquille (onglets, écrans, bouton +) qu'après** `bootstrapApp` (base ouverte, migrations, conteneur), `restoreSpaceFilter`, `restoreAppearance` et le premier contrôle du report (`startup.ready`). Avant, seul `app.loading` et le nom de l'app sont affichés.
8. `TaskCreateSheet` pose le focus du titre dans un `setTimeout(0)` ; le piège de focus de `Sheet` (`useFocusTrap`, `useEffect`) place d'abord le focus sur « Fermer ». Dans WKWebView, un `focus()` hors du traitement d'un geste n'ouvre pas le clavier.
9. Semaine : `useSwipe` (S-03) est posé sur le conteneur des jours (`touch-action: pan-y`) ; `useZoneDrag` (S-02) démarre le glisser après un appui de **400 ms** et l'abandonne dès que le doigt bouge de plus de **10 px**.

## Décision

### 0. Périmètre et couches

- **M0 (domain-logic, fusion avant le lot)** : `src/domain/appLock.ts`, `src/domain/signingNotice.ts`, deux clés locales dans `src/domain/model/settings.ts` (`security.appLock`, `notifications.signing`) **et** l'état de bandeau `signingExpiry` dans `src/domain/appStatus.ts` (correction du périmètre annoncé, écart 3). Ensuite le lot M ne touche ni `src/domain` ni `src/db`.
- **Aucune dépendance npm.** Les adaptateurs appellent `invoke` de `@tauri-apps/api/core` (comme `tauriNotifications.ts`).
- **Ports de plateforme** (un seul fichier nomme chaque plugin ou commande ; implémentation vide hors (`tauri`, `ios`) ; faux pour les tests ; prise de développement `__ctHaptics`, `__ctBiometric`, `__ctSigning` comme `__ctNotifications`, retirée du build) : `src/platform/haptics`, `src/platform/biometric`, `src/platform/signing`.
- **`src/ui` n'importe pas `src/platform`** : les composants reçoivent des rappels ; les features font le lien.

### 1. Gestes et retour haptique (A-07)

#### 1.1 Plugin haptique : maison, minimal

- **Décision** : plugin local `src-tauri/plugins/haptics` (crate `tauri-plugin-ct-haptics`, `links = "tauri-plugin-ct-haptics"`, nom de plugin Tauri **`haptics`**), même forme que `folder-bookmark`. Le plugin officiel n'est pas ajouté (constat 2).
- **Swift** (`HapticsPlugin.swift`, ~40 lignes) : trois commandes `impactFeedback({ style: 'light' | 'medium' | 'heavy' })`, `notificationFeedback({ type: 'success' | 'warning' | 'error' })`, `selectionFeedback()` ; chacune passe par `DispatchQueue.main.async { générateur ; invoke.resolve() }` ; valeur inconnue : `invoke.reject("invalid-argument")`. Pas de `vibrate`, pas de Core Haptics.
- **Rust** : `Builder::new("haptics").setup(register_ios_plugin)`, aucune commande Rust ; `build.rs` : `COMMANDS = ["impact_feedback", "notification_feedback", "selection_feedback"]`.
- **Cargo** : `tauri-plugin-ct-haptics = { path = "plugins/haptics" }` sous `[target.'cfg(target_os = "ios")'.dependencies]` ; `lib.rs` : `.plugin(tauri_plugin_ct_haptics::init())` sous le même `cfg`. Aucune clé Info.plist.
- **Capability** `src-tauri/capabilities/haptics-ios.json` : `windows: ["main"]`, `platforms: ["iOS"]`, exactement `haptics:allow-impact-feedback`, `haptics:allow-notification-feedback`, `haptics:allow-selection-feedback`.

#### 1.2 Port `src/platform/haptics`

```ts
export type ImpactStyle = 'light' | 'medium' | 'heavy';
export type FeedbackKind = 'success' | 'warning' | 'error';
/** Cosmétique : ne rejette jamais, n'attend rien. */
export interface Haptics {
  impact(style: ImpactStyle): void;
  notification(kind: FeedbackKind): void;
  selection(): void;
}
export function openHaptics(runtime: Runtime, os: Os, deps: { log: (code: string) => void }): Haptics;
```

Fichiers : `types.ts`, `noop.ts` (PC, navigateur), `fake.ts` (enregistre les appels), `tauriHaptics.ts` (**seul** fichier qui nomme `plugin:haptics|`), `index.ts`. Un rejet n'est pas affiché (cosmétique, fiche A-07) : `log('haptics-failed:{commande}')`, **une fois par commande et par processus** (le journal ne se remplit pas). `AppContainer` reçoit `haptics: Haptics`.

#### 1.3 Composant commun `src/ui/SwipeRow.tsx`

```ts
export interface RowGestureFeedback { threshold(): void; open(): void; commit(): void; succeeded(): void; longPress(): void }
export interface SwipeRowAction {
  readonly id: string;
  readonly label: string;                 // « Reporter » ; nom accessible : « {label} : {title} »
  readonly icon: LucideIcon;
  readonly tone: 'soft' | 'accent' | 'danger';   // #C9BEE6 / #5B43A8 / #A1271C (tokens)
  readonly onSelect: () => void;
}
export interface SwipeRowProps {
  readonly rowId: string;
  readonly title: string;
  /** Balayage à droite ; null : aucun. `onCommit` rend vrai si le cas d'usage a abouti. */
  readonly right: { readonly label: string; readonly tone: 'complete' | 'reopen'; readonly onCommit: () => Promise<boolean> } | null;
  /** 0 à 3 boutons de 62 px révélés par le balayage à gauche. */
  readonly left: readonly SwipeRowAction[];
  /** Appui long ; null dans la Semaine (le glisser S-02 garde l'appui long, D2). */
  readonly onLongPress: (() => void) | null;
  /** Mode édition (A-05), glisser en cours (S-02, A-02), écran PC. */
  readonly disabled: boolean;
  readonly feedback?: RowGestureFeedback;
  readonly children: ReactNode;
}
export function SwipeRowGroup(props: { children: ReactNode }): JSX.Element; // une seule ligne ouverte par groupe
```

Règle de geste (constantes exportées, testées) :

| Règle | Valeur |
| --- | --- |
| Pointeurs | `touch` et `pen` seulement ; `mouse` ignoré (PC inchangé, critère 12) |
| Départ ignoré | cible dans `input, textarea, select, [contenteditable], [data-no-row-gesture]` |
| Prise du geste | `|dx| ≥ 10 px` et `|dx| ≥ 2·|dy|` (même rapport que `useSwipe`) ; alors `setPointerCapture`, `touchmove` non passif bloqué, clic suivant avalé (`swallowClickAfterDrag`) |
| Abandon | `|dy| > 12 px` et `|dy| > |dx|` avant la prise (défilement), `pointercancel`, `disabled` devenu vrai |
| Droite, validation | au lâcher, `dx ≥ 40 %` de la largeur, ou `dx ≥ 40 px` à `≥ 0,5 px/ms` ; sinon retour sans effet |
| Gauche, ouverture | au lâcher, `−dx ≥ 62 px`, ou rapide (mêmes seuils) : la ligne reste ouverte à `−62 × n` px ; pas de validation par balayage complet (aucune suppression sans confirmation, D5) |
| Fermeture | toucher hors des boutons, balayage à droite de la ligne ouverte, ouverture d'une autre ligne du groupe, défilement, changement d'écran |
| Appui long | 500 ms sans dépasser 8 px, aucun geste pris ; `contextmenu` bloqué ; clic suivant avalé |
| Retour haptique | `threshold` au premier franchissement des 40 % (une fois par geste) ; `commit` (`impact('medium')`) au lâcher validant ; `succeeded` (`notification('success')`) **seulement** si `onCommit` rend vrai ; `open` (`impact('light')`) à l'ouverture gauche ; `longPress` (`impact('light')`) |
| Mouvement réduit | `prefers-reduced-motion` : aucune transition, effet immédiat |

Échec (critère 18) : `onCommit` faux ou rejeté → ligne refermée, aucun retour de succès ; l'erreur est affichée par l'écran (`actionErrorKey`), pas par `SwipeRow`.

**Équivalents VoiceOver** : `SwipeRow` rend, après `children` dans l'ordre du DOM, un groupe `role="group"` nommé « Actions : {title} » sans `aria-expanded` (ARIA 1.2 ne le prévoit pas pour ce rôle et VoiceOver annoncerait « réduit » ; retiré à la revue d'A-07), avec un bouton par action de `left` nommé « {label} : {title} », masqué visuellement (classe `ct-visually-hidden`, visible au focus) et appelant le même `onSelect`. L'appui long a pour équivalent le toucher du titre (A-08). Le résultat est annoncé par le bandeau (`role="status"`) ; après « Terminer » ou une suppression, le focus va à la ligne suivante (rappel fourni par l'écran).

**Branchements** (tasks-planning) : Aujourd'hui (`TodayRows`), « Un jour » (`SomedayRow` : boutons « Aujourd'hui », « Demain », « Date… », « Supprimer », D4), Semaine iPhone (`WeekItems`, `onLongPress: null`, `disabled: moves.dragging`). Routines du jour : `right` seulement (valider ou rouvrir pour la date affichée), `left: []`. Événements, checklists, objectifs, « Terminées » : pas de `SwipeRow`. Sur PC (`layout === 'pc'`) les lignes ne sont pas enveloppées. L'adaptateur `rowGestureFeedback(haptics)` vit dans `src/features/app`.

**Semaine, sans conflit avec Q16 et S-03.** (a) `useSwipe` ignore un geste dont la cible de `pointerdown` est dans `[data-row-gesture]` (attribut posé par `SwipeRow`) : sur une ligne, seule la ligne réagit ; sur l'en-tête et les zones vides, la semaine change ; les tests S-03 existants ne sont pas modifiés, un test est ajouté. (b) Avec `useZoneDrag` : un déplacement horizontal de plus de 10 px avant 400 ms arrête l'appui long du glisser (règle existante) et la ligne prend le geste ; un doigt immobile 400 ms démarre le glisser, `disabled` passe à vrai et `SwipeRow` abandonne. Les deux seuils de 10 px coïncident volontairement.

### 2. Verrouillage biométrique (I-03)

#### 2.1 Plugin

- `tauri-plugin-biometric = "=2.4.1"` sous `cfg(target_os = "ios")`, version **épinglée** (constats 3 à 6 ; toute montée exige une relecture et un avenant). `lib.rs` : `.plugin(tauri_plugin_biometric::init())` sous le même `cfg`.
- Capability `src-tauri/capabilities/biometric-ios.json` : `windows: ["main"]`, `platforms: ["iOS"]`, exactement `biometric:allow-status`, `biometric:allow-authenticate` (jamais `biometric:default`).
- **Info.plist** : `NSFaceIDUsageDescription` = « CircleTasks utilise Face ID pour garder vos tâches privées. » dans `src-tauri/Info.ios.plist` ; entrée `"biometric": { "story": "I-03", "usageDescriptions": ["NSFaceIDUsageDescription"] }` dans `scripts/ios/plist-contract.json`.

#### 2.2 Port `src/platform/biometric`

```ts
export type BiometryKind = 'face-id' | 'touch-id' | 'none';
export type AuthFailureCode =
  | 'user-cancel' | 'system-cancel' | 'app-cancel' | 'not-interactive' | 'authentication-failed'
  | 'passcode-not-set' | 'lockout' | 'not-available' | 'not-enrolled' | 'invalid-context' | 'user-fallback'
  | 'unavailable'   // plugin absent ou refusé par la capability
  | 'unknown';      // code nul ou inconnu (constat 5)
export interface BiometricStatus {
  readonly kind: BiometryKind;                         // biometryType, même indisponible
  readonly biometryAvailable: boolean;
  readonly passcode: 'set' | 'not-set' | 'unknown';    // 'set' si biométrie disponible ; 'not-set' si passcodeNotSet ; sinon 'unknown'
  readonly code: AuthFailureCode | null;
}
export type AuthResult = { readonly ok: true } | { readonly ok: false; readonly code: AuthFailureCode; readonly cancelled: boolean };
export interface AppAuthenticator {
  readonly supported: boolean;                          // faux sur PC et dans le navigateur
  /** Valeur figée au lancement du processus (constat 4) : sert au libellé et à l'invitation, jamais à une décision de sécurité. */
  status(): Promise<BiometricStatus>;                   // ne rejette jamais
  /** Toujours `allowDeviceCredential: true` (repli code de l'iPhone) ; raison et « Annuler » non vides (constat 5), sinon `invalid-context` sans appel. Un seul appel à la fois : un second rend la même promesse. Ne rejette jamais. */
  authenticate(reason: string, cancelLabel: string): Promise<AuthResult>;
}
```

`tauriBiometric.ts` est le **seul** fichier qui nomme `plugin:biometric|`. `cancelled` vaut vrai pour `user-cancel`, `system-cancel`, `app-cancel`. Le journal ne reçoit que le code.

#### 2.3 Politique (domaine pur, M0 : `src/domain/appLock.ts`)

```ts
export const APP_LOCK_RELOCK_MS = 30_000;
export const APP_LOCK_EXCURSION_MAX_MS = 5 * 60_000;
export interface AppLockInput {
  readonly enabled: boolean;
  readonly state: 'cold-start' | 'resume';
  readonly now: number;                                  // ms, horloge murale
  readonly backgroundedAt: number | null;                // instant du passage masqué ; null : inconnu
  readonly excursion: { readonly startedAt: number } | null;
}
export function shouldLock(input: AppLockInput): boolean;
export function parseAppLockSetting(raw: unknown): { readonly enabled: boolean; readonly unreadable: boolean };
```

Table : `enabled` faux → faux. `cold-start` → vrai. `resume` : `backgroundedAt` nul ou non fini → vrai ; `now < backgroundedAt` (horloge qui recule) → vrai ; excursion avec `startedAt ≤ backgroundedAt ≤ now` et `now − startedAt < 5 min` → faux ; sinon `now − backgroundedAt ≥ 30 000` → vrai (29 999 : faux). `parseAppLockSetting` : `true`/`false` lus tels quels ; `null` ou absent → faux ; **toute autre valeur → `{ enabled: true, unreadable: true }`** (échec fermé, journal `setting-unreadable`). Réglage `security.appLock` : `scope: 'local'`, valeur brute `unknown`, défaut `false` ; absent du catalogue de synchro et des déclencheurs de capture ; n'est pas observé par `observeWrites` (pas de replanification).

#### 2.4 Exécution (`src/features/security/`, nouveau)

Fichiers : `appLockStore.ts` (Zustand), `startAppLock.ts`, `excursion.ts`, `privacyCover.ts`, `AppLockGate.tsx`, `LockScreen.tsx` ; section `src/features/settings/SecuritySection.tsx` (iPhone seulement, absente si `!authenticator.supported`).

- **Échec fermé.** États : `unknown` (avant lecture du réglage) → `locked` | `unlocked`. Toute erreur (lecture du réglage, plugin, code inconnu) laisse `locked` avec un message ; aucun chemin ne passe de `locked` à `unlocked` sans `AuthResult.ok`, sauf la sortie « aucun code » ci-dessous.
- **Démarrage.** Le réglage est lu dans `App.tsx` **avec** `restoreAppearance`, avant `setContainer` (une lecture, aucun délai notable ; constat 7). Verrouillé à froid : la coquille **n'est pas montée** (aucune ligne dans le DOM), l'écran de verrou est le seul contenu ; la base, `startAppStartup`, la synchro, `startNotificationIntegration` et la file N-03 démarrent normalement (le verrou couvre l'interface, pas les données).
- **Reverrouillage au retour.** La coquille reste **montée** mais `hidden` + `inert` + `aria-hidden="true"` (aucun rendu, rien pour VoiceOver, état et saisie conservés, critère 6) ; raccourcis (`container.shortcuts`), bouton + et `UndoToast` inactifs ; `FocusHost` masqué.
- **Authentification automatique** : une fois par épisode de verrou (lancement ou retour), quand le document est visible ; si elle rend `not-interactive` ou `system-cancel`, un seul nouvel essai au prochain `focus` de la fenêtre ; ensuite seulement le bouton « Déverrouiller » (pas de boucle). Raison : `security.unlockReason` ; activation : « Activer le verrouillage de CircleTasks ».
- **Cache de confidentialité** (`privacyCover.ts`) : si le verrou est activé, à `visibilitychange` masqué et à `pagehide`, écouteurs posés **en premier** (phase de capture, sur `document`), écriture DOM directe `document.documentElement.dataset.privacy = 'on'` (pas de rendu React) : une couche opaque déjà présente dans `index.html` couvre `#root`. `backgroundedAt = Date.now()` est noté dans le même gestionnaire. Au retour : `shouldLock` vrai → état `locked` puis retrait du cache ; faux → retrait du cache. Le contenu n'est jamais repeint entre les deux.
- **Excursions.** `withExcursion<T>(kind: 'folder-picker' | 'camera' | 'system-settings' | 'permission', run: () => Promise<T>): Promise<T>` pose `{ startedAt }` avant `run`, l'efface au premier retour au premier plan qui suit (consommée une fois) et, au plus tard, après 5 min (`shouldLock`). Appelée **par les features** autour des appels de plateforme : choix du dossier (`sync_folder_choose`), scan du QR (`scanAndImport`), `openAppSettings` du scanner et tout lien vers Réglages iOS, demandes d'autorisation (notifications, Rappels de K-05). SideStore n'est pas une excursion : l'app n'y renvoie pas, et une mise à jour relance l'app (lancement à froid, verrouillé).
- **Activer / désactiver** : chacun exige `authenticate` réussi ; échec ou annulation : réglage inchangé, message « Le verrouillage n'a pas été activé » (ou « …désactivé »). Activation refusée sans appel si `status().passcode === 'not-set'` ou `!supported` (raison affichée) ; sinon l'appel tranche (`passcode-not-set` → même raison).
- **Plus de code sur l'iPhone** (verrou actif) : la sortie « Désactiver le verrouillage » n'est proposée **qu'après un `authenticate` de ce processus rendant `passcode-not-set`** (jamais sur la foi de `status`, figé, constat 4). Elle ouvre `ConfirmDialog` « Les données de CircleTasks seront de nouveau lisibles sans protection » ; confirmer écrit `security.appLock = false`, journalise `app-lock-disabled-no-passcode`, déverrouille. Sans code, l'iPhone n'a plus de protection : le verrou n'ajoute rien.
- **Plugin en échec** (`unavailable`, `unknown`, `invalid-context`) : message persistant avec le code et « Réessayer » sur l'écran de verrou, jamais de déverrouillage (l'écran de verrou est le seul écran : pas de bandeau).
- **Notifications** (N-03) : actions reçues pendant le verrou écrites dans la file durable et appliquées au passage suivant, verrouillé ou non ; le bandeau « Annuler » 5 s d'un « Fait » appliqué sous le verrou n'est pas affiché (aucun titre visible) ; une ouverture depuis une notification passe par le verrou.
- **Accessibilité** : bouton « Déverrouiller » nommé, message d'échec `role="alert"`, contraste AA clair et sombre, texte jusqu'à 200 %.

#### 2.5 Cache natif (prévision et repli)

Le cache JS ne couvre que le passage en arrière-plan. Le sélecteur d'apps ouvert sans quitter l'app laisse l'app **inactive**, sans `visibilitychange` : l'aperçu montrerait le contenu. Prévision de l'architecte : le contrôle A2 de l'appareil échoue dans ce cas. **Repli défini ici** : plugin local `src-tauri/plugins/privacy-shield` (Swift, ~50 lignes) qui ajoute une vue opaque à la fenêtre sur `willResignActive` et la retire sur `didBecomeActive`, activé par une commande `set_enabled({ enabled })` appelée au démarrage et à chaque changement du réglage (capability `privacy-shield:allow-set-enabled`, iOS seulement), échec de la commande → message dans Réglages > Sécurité ; aucune clé Info.plist. Construit sur constat de A2, ou dès ce lot si Ali le décide (question 1).

### 3. Expiration de la signature (I-02)

#### 3.1 Commande Rust `app_signing_info`

- **Module** `src-tauri/src/signing.rs`, compilé partout (tests `tests/desktop/signing.rs`) : `pub fn parse_provision(bytes: &[u8]) -> Result<SigningInfo, SigningError>` ; la **commande** `#[tauri::command] pub async fn app_signing_info() -> Result<SigningInfo, String>` est sous `#[cfg(target_os = "ios")]` (asynchrone : jamais sur le fil principal), ajoutée au `generate_handler!` iOS et au manifeste de `build.rs` (le test « union des gestionnaires = manifeste » reste vrai).
- **Sortie** : `{ "expiresAt": "2026-10-15T09:12:34Z", "issuedAt": "2026-10-08T09:12:34Z" | null }` (UTC) ; rejet = code seul : `profile-missing` (fichier absent), `profile-unreadable` (tout autre cas).
- **Lecture** : `current_exe()?.parent()` / `embedded.mobileprovision`, rien d'autre ; `symlink_metadata` : fichier ordinaire, taille dans `]0 ; 256 Kio]` ; sinon `profile-unreadable`.
- **Format** : le profil est un CMS (PKCS #7) dont le contenu est un plist XML en clair. Extraction des octets entre le premier `<?xml` et le premier `</plist>` qui le suit, UTF-8 strict. Seules clés lues : `<key>ExpirationDate</key>` puis blancs puis `<date>AAAA-MM-JJTHH:MM:SSZ</date>` (obligatoire), même forme pour `CreationDate` (facultative). Clé dupliquée, date hors format, date invalide au calendrier, année hors [2020 ; 2100], `issuedAt ≥ expiresAt` ou durée > 400 jours : `profile-unreadable`. Aucune vérification de signature CMS (le fichier est couvert par la signature du paquet). Pas de crate `plist` : analyse bornée écrite à la main.
- **Confidentialité** : jamais `TeamIdentifier`, `ProvisionedDevices`, certificats, droits, nom du profil ; le journal ne porte que le code.
- **Capability** `src-tauri/capabilities/signing-ios.json` : `windows: ["main"]`, `platforms: ["iOS"]`, exactement `allow-app-signing-info`.
- **SideStore** : AltSign (moteur de SideStore) écrit le profil gratuit de 7 jours dans le paquet à l'installation et à chaque actualisation ; prévision : présent. Contrôle A1 de l'appareil ; l'IPA de la CI (non signée) n'en a pas (étape d'information de `build-ios.yml`). Absent sur l'appareil : état `profile-missing` visible (« Date d'expiration inconnue »), et le repli « date d'installation estimée » fait l'objet d'un avenant ; il n'est pas codé maintenant.

#### 3.2 Port `src/platform/signing`

```ts
export type SigningReadFailure = 'profile-missing' | 'profile-unreadable' | 'unavailable';
export type SigningRead =
  | { readonly ok: true; readonly expiresAt: IsoDateTime; readonly issuedAt: IsoDateTime | null }
  | { readonly ok: false; readonly code: SigningReadFailure };
export interface SigningSource { readonly supported: boolean; read(): Promise<SigningRead> } // ne rejette jamais
```

`tauriSigning.ts` est le seul fichier qui nomme `app_signing_info`. Implémentation vide (PC, navigateur) : `supported: false`, `{ ok: false, code: 'unavailable' }` → état `unknown`, ligne « À propos » absente.

#### 3.3 Domaine (M0 : `src/domain/signingNotice.ts`)

```ts
export const SIGNING_ALERT_LEAD_MS = 24 * 3_600_000;
export type SigningNotice =
  | { readonly state: 'ok'; readonly expiresAt: number; readonly alertInstant: number; readonly alertAt: LocalDateTime }
  | { readonly state: 'soon'; readonly expiresAt: number; readonly remainingMs: number }
  | { readonly state: 'expired'; readonly expiresAt: number }
  | { readonly state: 'unknown' };
export function signingNotice(input: { readonly expiresAt: number | null; readonly now: number; readonly zone: string | null }): SigningNotice;
export interface SigningStatusV1 {
  readonly v: 1;
  readonly lastRead: { readonly at: IsoDateTime; readonly expiresAt: IsoDateTime; readonly issuedAt: IsoDateTime | null } | null;
  readonly failure: { readonly at: IsoDateTime; readonly code: 'profile-missing' | 'profile-unreadable' } | null;
  readonly scheduled: { readonly instant: number; readonly expiresAt: IsoDateTime } | null;   // alerte en attente (identifiant 2)
}
export function parseSigningStatus(raw: unknown): { readonly status: SigningStatusV1; readonly unreadable: boolean };
```

`alertInstant = expiresAt − 24 h` (instant absolu, pas « même heure la veille ») ; `alertAt = localDateTimeAt(alertInstant, zone)` (`notificationInstant.ts`, fuseau injecté, indépendant de `TZ`). `ok` si `alertInstant > now` ; `soon` si `now ≥ alertInstant` et `now < expiresAt` ; `expired` si `now ≥ expiresAt` ; `unknown` si `expiresAt` nul. Réglage `notifications.signing` : `scope: 'local'`, valeur brute `unknown`, défaut `null` ; illisible → journal `signing-status-unreadable`, lu comme vide. `APP_STATUS_PRIORITY` reçoit `signingExpiry` **en tête** (fenêtre de 24 h, l'app cesse ensuite de s'ouvrir) ; `detail` = `soon` | `expired`.

#### 3.4 Planification (feature `src/features/reminders/signingNotice.ts`)

- **Dans le passage du `NotificationRunner`** (ADR 0012 N1.3), pour les déclencheurs `open`, `resume`, `permission` : étape insérée **après** la lecture de l'autorisation (3) et **avant** `limit = 64 − reservedCount()` (5), pour que l'alerte compte dans le plafond du même passage (iOS écarte en silence au-delà de 64).
- `read()` → `signingNotice` → selon l'état : `ok` : `show` par le pont (`createIosNotificationBridge`) de l'identifiant **2**, `pluginDate(alertInstant, zone)`, `sound: 'default'`, sans `actionTypeId`, `extra: { sid: 'signing' }`, titre et corps de D1 (`src/i18n`, `notifications.signing.*`, heure 24 h) ; même instant et même texte déjà envoyés **par ce processus** et présents dans `get_pending` : rien (critère 4) ; premier passage d'un processus : renvoyé (réaffirmation, constat 9 de l'ADR 0012). `soon`, `expired` : `cancel([2])` si en attente, bandeau `signingExpiry`. Échec de lecture : l'alerte en attente d'une lecture réussie antérieure est **gardée** si son échéance est future ; état `failure` écrit, affiché.
- Autorisation `denied` ou `undetermined` : aucune planification ; « À propos » affiche « Les notifications sont refusées : vous ne serez pas prévenu ». Rejet de `show` ou identifiant 2 absent de `get_pending` après envoi : `planFailure` `schedule-failed` (chemin de N-01 critère 12, bandeau `remindersTrouble`).
- `replace` et `cancelAll` du plan ne touchent jamais l'identifiant 2 ; `reservedCount()` le compte.
- Dépendance : l'appui sur l'alerte livrée à un processus précédent arrête l'app avec le délégué du plugin officiel (ADR 0012, constat 9) ; I-02 suppose le plugin `notification-actions` (délégué remplacé), décidé par Ali pour N-03 (écart 6).

### 4. Capture rapide iPhone (Q-05)

- **Démarrage** : rien n'attend la synchro, `replanNotifications`, le passage Rappels Apple, les agendas ni l'authentification ; le verrou masque l'interface mais ne retarde ni l'ouverture de la base ni le montage du conteneur. La coquille, et donc le bouton +, est rendue dès que le conteneur existe (constat 7) ; elle n'est pas rendue avant (écart 1).
- **Focus synchrone au toucher.** (a) `useFocusTrap` ne déplace plus le focus si `document.activeElement` est déjà dans le conteneur et accepte `initialFocus?: RefObject<HTMLElement>`, posé dans un `useLayoutEffect` ; `Sheet` transmet `initialFocusRef`. (b) Les chemins d'ouverture (Fab d'Aujourd'hui, Semaine, « Un jour », détail de checklist, `app.newTask`, zone de notification) ouvrent la feuille dans `flushSync(() => open())` depuis le gestionnaire de l'événement : le montage et l'effet de mise en page qui appelle `titleRef.current.focus({ preventScroll: true })` s'exécutent **dans** le traitement du toucher. (c) `TaskCreateSheet` supprime son `setTimeout`. (d) La feuille et son champ ne sont ni `display: none`, ni `visibility: hidden`, ni `inert` au moment du focus ; l'animation d'entrée n'utilise que `transform` et `opacity`. (e) `AddSheet` et `TaskCreateSheet` restent importés statiquement (un `lazy` casserait la synchronie).
- **Champ** : `enterkeyhint="done"`, Entrée enregistre (D2).
- **Base occupée** : l'enregistrement qui n'aboutit pas en 2 s (écriture en attente, base verrouillée par une sauvegarde ou la synchro) affiche « La base n'est pas prête » avec « Réessayer », texte conservé ; un échec affiche l'erreur de la feuille (`role="alert"`), feuille ouverte.

### 5. Tests et CI

- **Cohérence (Vitest)**, sur le modèle de `src/platform/notifications/consistency.test.ts` : seuls `tauriHaptics.ts`, `tauriBiometric.ts`, `tauriSigning.ts` nomment `plugin:haptics|`, `plugin:biometric|`, `app_signing_info` ; `Cargo.toml` : `tauri-plugin-biometric = "=2.4.1"` et `tauri-plugin-ct-haptics` sous `cfg(target_os = "ios")` seulement ; `lib.rs` : enregistrements sous le même `cfg` ; aucune capability Windows n'accorde `haptics:`, `biometric:` ou `allow-app-signing-info`.
- **Rust** (`tests/desktop/config.rs`) : listes exactes de `haptics-ios.json`, `biometric-ios.json`, `signing-ios.json` ; (`tests/desktop/signing.rs`) : profil factice (plist entouré d'octets binaires), sans `ExpirationDate`, clé dupliquée, date invalide, vide, tronqué, > 256 Kio, sans `CreationDate` ; la sortie ne contient jamais `TeamIdentifier` ni `ProvisionedDevices` présents dans le profil factice.
- **Info.plist** : contrat avec l'entrée `biometric` ; test Vitest du contrat mis à jour.
- **`build-ios.yml`**, étape « Plugins iOS » : `cargo tree --target aarch64-apple-ios -i tauri-plugin-biometric` et `-i tauri-plugin-ct-haptics` réussissent, la même commande pour `x86_64-pc-windows-msvc` ne trouve rien ; étape d'information : présence de `embedded.mobileprovision` dans l'IPA écrite au résumé. Lancé sur la branche du lot, vert avant fusion.

## Conséquences

- Deux plugins locaux de plus (`haptics`, et `privacy-shield` si retenu) à maintenir en Swift ; un seul plugin officiel nouveau, épinglé.
- Un plugin biométrique cassé dans une version livrée bloque l'app derrière l'écran de verrou (échec fermé voulu, données intactes) : la CI vérifie l'enregistrement et la capability ; le contrôle A1 sur l'appareil précède toute publication du lot.
- `status` du plugin biométrique est figé par processus : il ne sert qu'aux libellés.
- L'alerte d'expiration lit un fichier du paquet sans plugin Swift ; son texte reste neutre car SideStore peut actualiser sans ouvrir l'app.
- Le focus synchrone modifie `useFocusTrap` et `Sheet`, partagés : tous les tests de feuilles et panneaux sont rejoués.

## Écarts avec les fiches (à reporter par le product-owner)

1. **Q-05 D1 et critère 2** : la coquille n'existe qu'après l'ouverture de la base (constat 7) ; toucher + « avant la fin de l'ouverture » est impossible sans réécrire le démarrage (écrans sans conteneur), ce qui contredirait aussi l'échec fermé d'I-03 (état du verrou inconnu avant la base). Retenu : critère 2 porte sur une **base occupée** à l'enregistrement ; la mesure ≤ 1 s du critère 6 inclut l'ouverture de la base.
2. **I-03 critères 6 et 7** : « aucune ligne dans le DOM » et « saisie en cours retrouvée » s'excluent au retour. Retenu : à froid, coquille non montée ; au retour, montée mais `hidden`, `inert`, `aria-hidden`.
3. **Périmètre M0** : `src/domain/appStatus.ts` (`signingExpiry`) s'ajoute à `appLock.ts`, `signingNotice.ts` et aux deux clés.
4. **A-07, ADR requis point 1** : plugin officiel écarté pour défaut de fil (constat 2), repli maison prévu par la fiche ; nom de plugin `haptics` et permissions inchangés (critère 15 inchangé), crate `tauri-plugin-ct-haptics` (étape CI à adapter).
5. **A-07 critère 11** : `useSwipe` reçoit une exclusion `[data-row-gesture]` (tests S-03 non modifiés, un test ajouté).
6. **I-02** : dépend du délégué `notification-actions` (décision d'Ali du 2026-10-08, commit `a521558` sur `ci-suite`, absent de la base `96236e0` du lot) : sans lui, l'appui sur l'alerte arrête l'app ; fusionner N-03 avant I-02 ou rebaser le lot.
7. **I-03 critère 9** : la sortie « Désactiver le verrouillage » exige un `authenticate` rendant `passcode-not-set` dans le processus, pas `status` (constat 4).
8. **I-03 critère 8 et A2** : le cache JS ne couvre pas l'app inactive dans le sélecteur d'apps (section 2.5).
9. **I-03 ADR requis point 2** : SideStore n'est pas une excursion (section 2.4).

## Question à Ali

1. Cache natif `privacy-shield` (section 2.5) dès ce lot, comme pour N-03 (évite un cycle CI et un passage sur l'appareil), ou seulement si A2 échoue ?

## Fichiers impactés

M0 : `src/domain/{appLock,signingNotice,appStatus}.ts` et tests, `src/domain/model/settings.ts`. Rust : `src-tauri/Cargo.toml`, `Cargo.lock`, `build.rs`, `src/lib.rs`, `src/signing.rs` (nouveau), `plugins/haptics/` (nouveau), `plugins/privacy-shield/` (si retenu), `capabilities/{haptics-ios,biometric-ios,signing-ios}.json` (nouveaux), `tests/desktop/{config,signing,main}.rs`, `Info.ios.plist`. Scripts et CI : `scripts/ios/plist-contract.json` et son test, `.github/workflows/build-ios.yml`. TypeScript : `src/platform/{haptics,biometric,signing}/` (nouveaux), `src/features/security/` (nouveau), `src/features/settings/SecuritySection.tsx`, `SettingsScreen.tsx`, `AboutSection.tsx`, `src/features/reminders/{signingNotice,replanNotifications,notificationStatus,RemindersStatusSection}.*`, `src/features/app/{container,bootstrap,AppStatusBanner}.ts(x)`, `src/App.tsx`, `index.html` (couche du cache), `src/ui/{SwipeRow,useSwipe,useFocusTrap,Sheet,index}.ts(x)`, `src/features/today/TodayRows.tsx`, `src/features/someday/SomedayRow.tsx`, `src/features/week/WeekItems.tsx`, `src/features/tasks/TaskCreateSheet.tsx`, chemins d'ouverture de la feuille, `src/features/sync/*` (excursions), `src/i18n/{fr,en}*`, `docs/install-iphone.md`, `tests/e2e/{A-07,Q-05,I-03,I-02}.spec.ts`. ADR 0012 : ligne d'avenant (identifiant réservé 2).

## Avenant I-03, lot M partie 1 (2026-10-08) — écarts d'implémentation

1. **`links` du plugin haptics (correction de §1.1).** Le préfixe des permissions est tiré de `links`, pas du nom du crate ni de `Builder::new` (`tauri-utils` 2.10.1, `acl::build::read_permissions` : `DEP_TAURI_PLUGIN_<NOM>_PERMISSION_FILES_PATH`, « tauri-plugin- » retiré). Avec `links = "tauri-plugin-ct-haptics"`, les permissions seraient `ct-haptics:allow-*` et tout appel `plugin:haptics|…` serait refusé. Retenu : crate `tauri-plugin-ct-haptics`, **`links = "tauri-plugin-haptics"`**, `Builder::new("haptics")`, permissions `haptics:allow-*` (inchangées). Le plugin officiel `tauri-plugin-haptics` ne peut alors plus être une dépendance (même `links`, refusé par Cargo) : c'est voulu (constat 2). Test `lot_m_local_plugins_acl_prefix_matches_runtime_name` (`tests/desktop/config.rs`).
2. **`privacy-shield` construit dès ce lot** (décision d'Ali, question 1) : crate `tauri-plugin-privacy-shield` (`links` identique), commande `set_enabled`, capability `privacy-shield-ios.json` (`privacy-shield:allow-set-enabled`), vue opaque `UIColor.systemBackground` posée à `willResignActive` et `didEnterBackground`, retirée à `didBecomeActive`. Port `src/platform/privacyShield` (vide hors iPhone, faux, `tauriPrivacyShield.ts` seul à nommer le plugin). Échec : code dans Réglages > DONNÉES ET SÉCURITÉ.
3. **Excursions, plus strict que §2.4 (revue, audit M1)** : seule `system-settings` (Réglages iOS, l'app passe en arrière-plan) dispense du délai de 30 s au retour. Le sélecteur de dossier, la caméra du scan et les fenêtres d'autorisation s'affichent dans l'app : un vrai passage en arrière-plan pendant l'une d'elles suit la règle des 30 s. Une excursion dont la promesse se termine pendant que le document est visible est effacée aussitôt ; `system-settings` (dont la promesse se résout avant le passage en arrière-plan) attend le retour ou ses 5 min.
4. **Masquage** : au verrou, le contrôleur masque par écriture DOM directe tous les enfants de `body` (`hidden`, `inert`, `aria-hidden`, valeurs d'avant rendues au déverrouillage) sauf la couche de l'écran de verrou `#ct-lock-layer` et le cache `#ct-privacy-cover` : les portails (`ConfirmDialog`, `ScanDialog`) sont couverts comme `#root`. La coquille déjà montée est en plus enveloppée (`.ct-lock-content`, `display: contents`) `hidden` + `inert` + `aria-hidden`.
5. **Horloge** : `startAppLockFor` lit `container.clock` (horloge système en production, horloge Playwright en e2e).
6. **Écran de verrou** : pas de maquette ; icône Lucide `LockKeyhole` sur pastille, nom de l'app, titre Fraunces, bouton primaire, `ConfirmDialog` (T-08) pour la sortie « aucun code ». Ligne de Réglages : « Verrouillage Face ID » de Reglages.html, section DONNÉES ET SÉCURITÉ (plutôt qu'une section « Sécurité » séparée).
7. **Horloge monotone (revue, audit B1)** : le retour verrouille si l'heure système OU `performance.now()` indique le délai écoulé (30 s, ou 5 min pour l'excursion vers Réglages iOS). WebKit tire `performance.now()` de `MonotonicTime::now()` = `mach_absolute_time()` sous Darwin (vérifié dans `Source/WTF/wtf/CurrentTime.cpp`), même base que `ProcessInfo.systemUptime` : elle avance pendant la suspension de l'app, ne s'arrête que pendant la veille de l'iPhone, que l'heure système couvre alors. Aucun code natif ajouté ; contrôle sur l'appareil dans la checklist.
8. **Excursion Réglages iOS et authentification (revue, audits B2 et B3)** : l'excursion `system-settings` ne vaut que si l'app passe en arrière-plan dans les 3 s qui suivent son départ (heure système et horloge monotone) ; un succès de `authenticate` obtenu alors que l'app est passée en arrière-plan pendant l'appel est ignoré (journal `unlock-ignored-background`, message « Déverrouillage annulé », nouvel essai).

## Avenant I-02 et Q-05, lot M partie 3 (2026-10-08) — écarts d'implémentation

1. **Étape d'alerte avant le refus d'autorisation (I-02, §3.4).** `runSigningStep` est appelée juste après la lecture de l'autorisation et AVANT le retour `blocked` : l'autorisation refusée ou non décidée ne planifie rien, mais la date lue est tout de même enregistrée (`notifications.signing`) pour que « À propos » la montre avec « Les notifications sont refusées : vous ne serez pas prévenu ». Elle s'exécute pour `open`, `resume` et `permission` seulement, et toujours avant `64 − reservedCount()`.
2. **Échec de l'alerte et `planFailure` (§3.4).** Le passage de réussite efface `planFailure` (N-01). L'échec de l'alerte (rejet de `show`, identifiant 2 absent de `get_pending`, exception de la lecture) est donc gardé en mémoire de processus par l'étape et réinscrit dans `planFailure` (`schedule-failed`) par chaque passage, quel que soit son déclencheur, jusqu'à la prochaine étape qui réussit : le bandeau « Les rappels n'ont pas pu être planifiés » ne disparaît pas à la première modification de tâche.
3. **Codes de lecture.** `unavailable` (commande absente ou refusée par la capability) est enregistré comme `profile-unreadable` : « Date d'expiration inconnue » est affiché (jamais un silence). Le bandeau `signingExpiry` est retiré à toute lecture en échec (une durée restante calculée sur une date périmée serait fausse) ; l'alerte planifiée par une lecture réussie antérieure est gardée.
4. **Ports.** `container.signing = { source, alert }` (`src/platform/signing`) : l'alerte passe par le pont `createIosNotificationBridge` (identifiant 2, `extra.sid = 'signing'`, sans catégorie) ; hook de développement `__ctSigning` / `__ctSigningFake`. Le calendrier « dans N jours » arrondit au jour le plus proche (une échéance à 5 j 23 h 59 min dit « dans 6 jours »).
5. **CI.** `build-ios.yml` écrit au résumé la présence de `embedded.mobileprovision` dans l'IPA (information, une IPA non signée n'en a pas) ; aucune nouvelle étape `cargo tree` (la commande n'est pas un plugin).
6. **Q-05 : coût de l'ouverture (§4).** Le focus synchrone (`openNow` = `flushSync`, `Sheet.initialFocusRef` dans un effet de mise en page) exécute le rendu complet de la feuille dans le toucher. Mesure initiale : plus de 1 000 ms à CPU 4×. Corrigé sans changer de comportement : roue des jours fenêtrée au montage (±30 éléments puis liste complète à l'image suivante), premier calage des roues à l'image suivante avant l'affichage (un `scrollTop` lu puis écrit par roue forçait une mise en page par roue), libellés de jours calculés à la lecture, `Intl.PluralRules` mis en cache. Résultat : 208 ms (build de production, CPU 4×).
7. **`useFocusTrap` : comportement modifié (revue I2).** À l'activation, le piège ne déplace plus le focus si `document.activeElement` est déjà dans le conteneur : un champ à `autoFocus` (ou focalisé par l'enfant dans un effet de mise en page) le garde, au lieu de le céder au premier élément focusable. `initialFocus` (via `Sheet.initialFocusRef`) prime sur ce focus déjà posé. Sans l'un ni l'autre, le premier élément focusable reçoit le focus comme avant. Tests : `useFocusTrap.test.tsx` (focus initial, focus conservé, piège interne ConfirmDialog dans une Sheet), `DatePrompt.test.tsx` (PC : champ Date ; iPhone : focus dans la feuille).
8. **Feuille « Nouvelle tâche » : bas rendu après le premier affichage et roue des jours par fenêtre (Q-05, revue I3).** La mesure va jusqu'à la feuille AFFICHÉE (image puis minuterie) sur le build de production. Pour tenir 300 ms à CPU 4× : le bas de la feuille est monté dans `startTransition` (le champ Titre, focalisé dans le geste, et l'aperçu sont rendus d'abord ; la feuille a sa hauteur finale, `ct-sheet--tall`) ; la roue des jours ne rend jamais ses 791 éléments (fenêtre de 81 éléments et deux espaceurs, recentrée au défilement et au choix extérieur, `overflow-anchor: none`). Les formulaires Événement et Routine posent aussi leur focus dans le geste (décision du 2026-10-08).
9. **Build des mesures @perf (revue B1).** `playwright.config.ts` lance un second serveur : `vite build --outDir dist-perf` avec `VITE_CT_E2E_HOOKS=1` (`vite.config.ts` : `define` de `import.meta.env.DEV`, React reste en mode production) puis `vite preview` sur `E2E_PREVIEW_PORT` (4173, ou `CT_E2E_PORT_BASE` + 4). Le projet `perf` y pointe. Le drapeau n'existe que là : `tests/bundle/startBundle.test.ts` vérifie que le build livré ne contient aucune accroche `__ct*` et qu'aucun workflow ni script ne le pose.
10. **Base occupée : « Réessayer » relance (revue Q-05).** L'écriture qui n'aboutit pas en 2 s ne peut pas être annulée (cas d'usage déjà parti) : « Réessayer » l'abandonne (elle ne décide plus de la feuille) et en lance une nouvelle avec le même texte ; le formulaire reste figé pendant l'attente (aucune modification perdue en silence). La fin de toute écriture est dite : feuille ouverte, fermeture ou erreur ; feuille fermée entre-temps, un message (`useNoticeStore`) dit si la tâche a été enregistrée ou non ; écriture abandonnée puis aboutie, un message prévient du doublon possible. Le bouton disparaît pendant la nouvelle écriture (pas de salve de clics).
11. **Budget du bundle de départ (350 Ko).** Tenu par deux chargements à la demande : (a) les formulaires Événement et Routine de la feuille Ajout et du panneau de modification (`LazyEventForm`, `LazyRoutineForm`, via `lazyScreen` ; chargés dès l'ouverture de la feuille et par `preloadScreens`, donc rendus directement et focalisés dans le geste au changement de segment) ; (b) l'étape d'alerte d'expiration (`signingNotice`, importée par `replanNotifications` sur l'iPhone seulement, `source.supported`).
