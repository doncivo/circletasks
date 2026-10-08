# ADR 0015 — Vision et Speech sur iPhone, autorisations de capture

- Statut : accepté (contrat ; implémentation par ios-mobile et quick-capture, relectures qa-test, code-reviewer, security-privacy)
- Date : 2026-10-08
- Stories : CAP-IOS-01 (plugins Vision et Speech), I-05 (moment des autorisations, partie micro et reconnaissance vocale, contrat Info.plist complet) ; solde Q-04 critère 13 et Q-03 critère 5 ; lot C, ordre 5, phase 3, branche `lot-c-ios`
- Complète : ADR 0007 (avenant I-01 : contrat Info.plist), ADR 0011 §22 points 1 et 2 (plugin appelé par Rust seul, fixture de contrat, aucune chaîne française en Swift) et §23 point 2 (caméra : explication puis demande), ADR 0013 (constat 1, §2.4 excursions et avenant I-03 point 3). Le numéro 0014 est réservé à l'ADR du journal d'I-04 (lot F).
- Sources relues le 2026-10-08 : fiches CAP-IOS-01, I-05, Q-03, Q-04, I-04 ; `docs/decisions.md` (2026-10-08, phase 3) ; `src/platform/{ocr,speech}/*`, `src/platform/sync/tauriSync.ts`, `src/features/capture/{Dictation.tsx,scan/useScan.ts,scan/prepareImage.ts,scan/scanLines.ts}`, `src/features/security/excursion.ts`, `src/features/reminders/requestPermission.ts` ; `src-tauri/src/ocr/{mod,win}.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/{ocr,sync-ios,*-ios}.json`, `src-tauri/plugins/{folder-bookmark,haptics}` ; `scripts/ios/plist-contract.json`, `src-tauri/Info.ios.plist`, `.github/workflows/build-ios.yml` ; `tauri` 2.12.1 (`mobile/ios-api/Sources/Tauri/Tauri.swift`, `src/plugin/mobile.rs`, `scripts/ipc-protocol.js`), `tauri-plugin-barcode-scanner` 2.5.1 (`ios/Sources/BarcodeScannerPlugin.swift`).

## Contexte

Q-04 lit les photos de listes sur iPhone avec le repli tesseract.js ; Q-03 laisse la dictée au clavier iOS. Le PRD (section 7) prévoit à l'ordre 5 Vision (plugin Swift) et Speech (plugin Swift, en option). Décisions du 2026-10-08 : dictée **sur l'appareil seulement** (Q-03 critère 7 : aucun audio envoyé), message persistant si le modèle français hors ligne manque ; Vision appelé **par Rust seul**, erreur visible avec « Lire avec le moteur intégré », jamais de repli silencieux ; **pas de section « Autorisations »** dans Réglages. Contraintes : pas de Mac (CI seule), Apple ID gratuit (aucun droit ni mode d'arrière-plan), aucun échec silencieux (règle d'Ali), le PC ne change pas.

## Constats de lecture

1. **Le module `ocr` est `#[cfg(desktop)]`** (`lib.rs`) et ses deux commandes ne sont enregistrées que dans le gestionnaire du PC ; la capability `ocr.json` est `platforms: ["windows"]`. `ocr_recognize` lit un corps binaire (`InvokeBody::Raw`) ; sur iOS, Tauri 2.12.1 passe l'IPC par le protocole personnalisé (`fetch` POST, corps lu ; seul Android en est exclu, `ipc-protocol.js`) : le même transport binaire vaut pour l'iPhone. Si ce protocole échoue, Tauri bascule sur `postMessage` et le corps n'est plus `Raw` : Rust rend `ocr-empty-image` (comportement actuel, gardé).
2. **`OcrLine` n'a pas de champ de confiance** (Windows n'en donne pas, Q-04 D2) ; le front applique déjà `confidence < 60` à toute ligne qui en porte une (`scanLines.ts`, `MIN_CONFIDENCE`), quel que soit le moteur. `useScan.ts` n'ouvre l'écran « indisponible » que pour `language-missing` du moteur `windows`, et ses textes (`fr.scan.ts`, `unavailable`) décrivent les Paramètres Windows.
3. **`prepareImage` rend du JPEG 92 % ou du PNG (source PNG), 2 000 px au plus**, orientation EXIF déjà appliquée par le canevas ; sans contexte 2D il rend l'image source telle quelle (jusqu'à 10 Mo, dimensions d'origine).
4. **Tauri appelle les méthodes Swift sur une file série unique `ipc`**, partagée par tous les plugins (ADR 0013 constat 1, `Tauri.swift`). **`run_mobile_plugin` attend la réponse sans délai** (`rx.recv()`, `mobile.rs`) : une méthode Swift qui ne résout jamais bloque le fil Rust appelant pour toujours.
5. **`openAppSettings` de `tauri-plugin-barcode-scanner` 2.5.1 peut ne jamais répondre** (URL nulle ou `canOpenURL` faux : `return` sans `resolve`) et **ignore l'échec** de `UIApplication.open` (`success` non lu). Réutilisé pour la dictée, ce serait un bouton qui peut ne rien faire sans le dire.
6. **`SpeechRecognizer` ne connaît que `isAvailable` et `listen`** ; `SpeechFailure` = `permission-denied | unavailable | failed`. `Dictation.tsx` affiche un message qui disparaît au prochain appui, sans renvoi aux Réglages (état des lieux d'I-05).
7. **iPhone minimum : iOS 18.0** (`tauri.conf.json`) ; les `Package.swift` des plugins locaux déclarent `.iOS(.v14)`.
8. **Aucun journal persistant sur cette branche** : `logFailure(scope, detail)` (`src/platform/desktop/log.ts`) n'écrit que dans la console ; I-04 (lot F, ADR 0014) le rendra durable et lisible dans Réglages › À propos › Logs. Aucun `applog` Rust n'existe encore.
9. **API Apple retenues** (documentation Apple ; ce qui ne se prouve que sur l'appareil est reporté dans la checklist) :
   - Vision : `VNRecognizeTextRequest` (`recognitionLevel = .accurate`, `usesLanguageCorrection`, `recognitionLanguages` ordonnées par priorité, `automaticallyDetectsLanguage` iOS 16+, `revision` `VNRecognizeTextRequestRevision3` iOS 16+, `supportedRecognitionLanguages()` iOS 15+, qui lève une erreur) ; résultats `VNRecognizedTextObservation` (une ligne de texte), `topCandidates(1)` → `VNRecognizedText.string` et `.confidence` (`Float` de 0 à 1) ; `boundingBox` normalisé, origine en bas à gauche, **ordre des observations non garanti** ; `VNImageRequestHandler.perform` est **synchrone** et doit tourner hors du fil principal ; `VNRequest.cancel()` interrompt une requête en cours. En mode précis, les confiances sont souvent grossières (paliers) : à mesurer (A1).
   - Image : `CGImageSourceCreateWithData` puis `CGImageSourceCopyPropertiesAtIndex` lit largeur, hauteur et orientation **sans décoder** ; `CGImageSourceCreateImageAtIndex` décode.
   - Speech : `SFSpeechRecognizer(locale:)` rend `nil` pour une langue non prise en charge ; `supportsOnDeviceRecognition` (modèle de l'appareil présent) ; `SFSpeechAudioBufferRecognitionRequest.requiresOnDeviceRecognition = true` interdit l'envoi aux serveurs d'Apple (la requête échoue si le modèle manque) ; `addsPunctuation` (iOS 16+) ; `SFSpeechRecognizer.authorizationStatus()` / `requestAuthorization` (rappel sur une file quelconque) ; `queue` (file des rappels de résultat, **principale par défaut**) ; l'autorisation de reconnaissance vocale est exigée **même** sur l'appareil.
   - Micro : `AVAudioApplication.shared.recordPermission` et `AVAudioApplication.requestRecordPermission` (iOS 17+, remplacent l'API d'`AVAudioSession` dépréciée) ; `AVAudioSession` catégorie `.record`, mode `.measurement`, `setActive(true)` puis `setActive(false, options: .notifyOthersOnDeactivation)` (appels bloquants : hors fil principal) ; notifications `interruptionNotification`, `routeChangeNotification`, `mediaServicesWereResetNotification` ; `AVAudioEngine.inputNode.installTap` (rappel sur un fil audio ; `append` de la requête y est permis).
   - Sans `UIBackgroundModes` `audio`, la capture s'interrompt quand l'app passe en arrière-plan ; l'indicateur orange s'éteint quand la session est désactivée.
   - Clés d'usage : une demande de micro sans `NSMicrophoneUsageDescription`, ou de reconnaissance vocale sans `NSSpeechRecognitionUsageDescription`, **termine l'app** ; le choix « Prendre une photo » d'un `<input type="file" accept="image/*">` dans WKWebView exige `NSCameraUsageDescription` (Vision lui-même n'en demande aucune) ; la photothèque passe par le sélecteur du système, sans autorisation.
   - La fenêtre d'iOS pour la reconnaissance vocale ajoute **son propre texte**, qui annonce un envoi de la voix à Apple, même quand l'app impose l'appareil : à confronter à l'explication d'I-05 (écart 4).
   - **Changer une autorisation de confidentialité dans Réglages iOS peut terminer l'app** en arrière-plan : le « retour » peut être un lancement à froid (écart 5).
   - Non retenus : l'API Swift de Vision d'iOS 18 (`RecognizeTextRequest`, asynchrone) et `SpeechAnalyzer` d'iOS 26 (minimum de l'app : 18.0 ; une seule API par plugin, éprouvée et testable par contrôle statique).

## Décision

### 0. Périmètre et couches

- **Ni `src/domain` ni `src/db`** : aucune règle métier nouvelle (lignes → tâches, incertitude, dates restent dans `scanLinesToProposals` et `parseQuickInput`, inchangés), aucune table, aucun réglage, aucune migration. La table « état d'autorisation → écran » d'I-05 est de la présentation de plateforme : `src/features/capture/dictationPermission.ts` (fonction pure, testée), pas `src/domain`.
- **Aucune dépendance npm ni cargo externe** : deux crates locaux (`tauri-plugin-vision`, `tauri-plugin-speech`), `base64` et `serde_json` déjà présents ; frameworks Apple du système (Vision, ImageIO, Speech, AVFAudio, UIKit). `cargo tree` : aucune entrée nouvelle hors des deux crates locaux.
- **Rust seul appelle les plugins** (ADR 0011 §22 point 1) : `build.rs` de chaque plugin déclare `COMMANDS = &[]` ; aucune permission `vision:` ni `speech:` dans aucune capability. La WebView n'appelle que des commandes de l'app.
- **Swift sans texte d'interface** : rejets = codes du contrat (`invoke.reject(code, code: code)`), jamais un message système, un chemin, un texte reconnu.
- **Chaque méthode Swift résout ou rejette sur tous ses chemins** (contrôle statique : aucun `return` nu après un `guard` sans `invoke.resolve`/`reject`) ; et Rust ne l'attend jamais sans délai (section 3.1).
- Journal : sur cette branche, les codes passent par `logFailure('capture', code)` ; I-04 (lot F) les rendra durables sans changer les appelants. Rust n'écrit rien lui-même : il rend le code au front, qui affiche et journalise (code seul ; jamais de texte reconnu, d'image, d'état brut d'autorisation).

### 1. Vision derrière `ocr_status` et `ocr_recognize`

#### 1.1 Rust (`src-tauri/src/ocr/`)

- `lib.rs` : `#[cfg(any(desktop, target_os = "ios"))] pub mod ocr;` ; `ocr::ocr_status` et `ocr::ocr_recognize` ajoutés au gestionnaire iOS. `mod win` reste `#[cfg(windows)]`.
- Nouveau `ocr/vision.rs`, **compilé partout** (testé par `cargo test` sous Windows avec un faux transport, comme `sync/bookmark.rs`) : trait `VisionTransport { fn status(&self) -> Result<Value, String>; fn recognize(&self, args: Value) -> Result<Value, String>; }`, lecture des réponses, tri, conversion de confiance, correspondance des codes. Transport de production `#[cfg(target_os = "ios")]` sur `tauri_plugin_vision::Vision::call`.
- Signatures : `ocr_status<R: Runtime>(app: AppHandle<R>) -> OcrStatus` et `ocr_recognize<R: Runtime>(app: AppHandle<R>, request: Request<'_>)` (paramètre `app` injecté par Tauri : appel JS inchangé). Windows ignore `app`.
- **Entrées contrôlées avant tout appel du plugin** (critère 3) : `validate_image` existant (vide → `ocr-empty-image`, plus de `MAX_IMAGE_BYTES` = 12 Mio → `ocr-too-large`, signature inconnue → `ocr-unsupported-format`) ; sur iOS **PNG et JPEG seulement** (BMP → `ocr-unsupported-format`) ; nouvelle fonction pure `declared_dimensions(bytes, kind) -> Option<(u32, u32)>` (PNG : en-tête `IHDR` ; JPEG : premier segment `SOF0` à `SOF15` hors `DHT`/`JPG`/`DAC`, parcours borné des segments), absente ou nulle → `ocr-unsupported-format`, puis `check_dimensions(w, h, VISION_MAX_SIDE)` avec **`VISION_MAX_SIDE = 4096`** et `MAX_PIXELS` existant → `ocr-dimensions-too-large`. Le front réduit à 2 000 px (Q-04 critère 3) ; 4 096 couvre le seul cas où `prepareImage` rend la source (constat 3).
- Appel : octets encodés en base64 dans `{ image, languages: ["fr-FR", "en-US"], maxSide: 4096, maxLines: 500 }` ; une lecture à la fois (`AtomicBool` dans l'état géré ; seconde lecture → `ocr-engine`, détail `busy`) ; délai **20 s** (section 3.1) ; tampons libérés à la sortie ; **aucune API d'écriture de fichier dans le module** (contrôle statique des imports : ni `std::fs`, ni `File`, ni `tempfile`).
- Réponse : lignes triées **de haut en bas puis de gauche à droite** (`y` décroissant par bandes de 1 % de la hauteur, puis `x` croissant) en Rust (constat 9 : ordre non garanti), nettoyées par `clean_lines` existant (500 au plus), confiance **`(c × 100).round()` bornée à 0..=100** ; valeur absente, `NaN` ou hors de 0..1 → ligne sans confiance (l'heuristique de texte s'applique seule).
- `OcrLine` gagne `#[serde(skip_serializing_if = "Option::is_none")] confidence: Option<u8>` (additif : Windows ne l'émet jamais, ses tests restent valides).
- `OcrStatus` gagne `#[serde(skip_serializing_if = "Option::is_none")] reason: Option<&'static str>` : `"language-missing"` (aucune variante `fr` rendue par Vision) ou `"plugin-unavailable"` (plugin absent, refusé, délai dépassé, réponse illisible). `available` = une langue `fr` présente (`pick_french` existant). `ocr_status` **n'échoue jamais** (règle actuelle).
- Codes Swift → codes Rust existants (aucun code nouveau côté front) :

| Swift | Rust | `OcrFailure` (TS) |
| --- | --- | --- |
| `unsupported-format` | `ocr-unsupported-format` | `unsupported-format` |
| `dimensions` | `ocr-dimensions-too-large` | `dimensions` |
| `language-missing` | `ocr-language-missing` | `language-missing` |
| `invalid-argument`, `busy`, `timeout`, `failed`, code inconnu | `ocr-engine` | `failed` |
| plugin absent, `run_mobile_plugin` en échec, délai Rust | `ocr-unavailable` | `unavailable` |

  Le `message` de l'erreur porte le code Swift seul (jamais de texte système), pour le journal.

#### 1.2 Plugin Swift `vision` (`src-tauri/plugins/vision/`)

Crate `tauri-plugin-vision`, `links = "tauri-plugin-vision"`, `Builder::new("vision")`, point d'entrée `init_plugin_vision`, structure calquée sur `folder-bookmark` (`call` bloquant, code rejeté rendu, `io` → ici `failed` à défaut). `Package.swift` : `.iOS(.v17)` (section 4.4).

| Méthode | Entrée | Sortie | Rejets |
| --- | --- | --- | --- |
| `status` | — | `{ languages: [String] }` : `supportedRecognitionLanguages()` d'une requête `.accurate`, révision 3 | `failed` |
| `recognize` | `{ image: base64, languages: [String], maxSide: Int, maxLines: Int }` | `{ lines: [{ text, confidence, x, y }] }` (`x` = `boundingBox.minX`, `y` = `boundingBox.maxY`, normalisés) | `invalid-argument`, `unsupported-format`, `dimensions`, `language-missing`, `busy`, `timeout`, `failed` |

- File : **`visionQueue` série dédiée** (QoS `.userInitiated`) ; la méthode rend la main à la file `ipc` aussitôt (constat 4). Jamais le fil principal (`perform` synchrone).
- Image : `Data(base64Encoded:)` ; `CGImageSource` (`kCGImageSourceShouldCache: false`) ; propriétés lues **avant décodage** : dimensions recontrôlées contre `maxSide` (`dimensions`), orientation `kCGImagePropertyOrientation` passée à `VNImageRequestHandler(cgImage:orientation:options:)` ; décodage impossible → `unsupported-format`.
- Requête : `recognitionLevel = .accurate`, `usesLanguageCorrection = true`, `revision = VNRecognizeTextRequestRevision3`, `automaticallyDetectsLanguage = false`, `recognitionLanguages = ["fr-FR", "en-US"]` (français prioritaire, anglais pour les mots courants d'une liste mixte ; voir écart 1) ; si `fr-FR` n'est pas dans `supportedRecognitionLanguages()` → `language-missing`.
- Garde : minuteur de **15 s** sur `visionQueue` qui appelle `request.cancel()` et rejette `timeout` ; un seul `resolve`/`reject` par appel (drapeau). Seconde lecture pendant une lecture → `busy`.
- Tout reste en mémoire : ni `FileManager`, ni `write(to:)`, ni `UIImageWriteToSavedPhotosAlbum`, ni `URLSession` (contrôle statique, critère 5).

#### 1.3 TypeScript (`src/platform/ocr/`)

- `windowsOcr.ts` devient **`nativeOcr.ts`** : `createNativeOcr(id: 'windows' | 'vision')` ; `createWindowsOcr()` reste exporté (`createNativeOcr('windows')`) pour ne pas toucher aux tests Q-04. Seul fichier à nommer `ocr_status` / `ocr_recognize`. La confiance reçue est rendue telle quelle (déjà 0 à 100).
- `openOcrService` : (`tauri`, `ios`) → `primary = createNativeOcr('vision')`, `fallback` = tesseract.js ; (`tauri`, `windows`) inchangé ; web → `primary` nul (critère 1).
- `OcrEngineStatus` gagne `reason?: 'language-missing' | 'plugin-unavailable'` (additif) ; le commentaire de `OcrLineResult.confidence` cite Vision et tesseract.
- `useScan.ts` (quick-capture) : moteur `vision` **indisponible** (`available: false`) → étape `unavailable` avec un texte propre à l'iPhone (`scan.unavailableIos`, sans Paramètres Windows) portant le code (`plugin-unavailable` ou `language-missing`) et « Lire avec le moteur intégré » ; journal `vision-plugin-unavailable` ou `vision-language-missing`. Lecture rejetée par `vision` (`failed`, `unavailable`, `dimensions`) → étape `error` persistante « La lecture n'a pas abouti » avec le code, « Réessayer » et « Lire avec le moteur intégré » (critère 4) ; journal `vision-<raison>`. **Jamais** de bascule automatique vers tesseract.

### 2. Speech (dictée sur l'appareil)

#### 2.1 Commandes Rust (`src-tauri/src/speech/`, nouveau)

`speech/mod.rs` compilé partout (logique et faux transport testés sous Windows), `speech/ios.rs` `#[cfg(target_os = "ios")]` (transport `tauri_plugin_speech::Speech::call`) ; commandes enregistrées **dans le gestionnaire iOS seulement**, ajoutées à `AppManifest::commands` de `build.rs`.

| Commande | Entrée | Sortie | Erreurs `{ code, message }` |
| --- | --- | --- | --- |
| `speech_status` | — | `{ available, onDevice, microphone, speechRecognition, reason? }` | jamais (plugin absent → `available: false`, `reason: "plugin-unavailable"`) |
| `speech_request_permissions` | — | `{ microphone, speechRecognition }` | `speech-unavailable` |
| `speech_listen` | `{ locale: "fr-FR" }` (toute autre valeur refusée `speech-failed`) | `{ text, stoppedBy }` | `speech-microphone-denied`, `speech-recognition-denied`, `speech-on-device-unavailable`, `speech-busy`, `speech-audio-unavailable`, `speech-unavailable`, `speech-timeout`, `speech-failed` |
| `speech_stop` | — | `{ stopped: bool }` (`false` sans écoute : aucun effet) | jamais |
| `app_settings_open` | — | `{ opened: bool }` | `settings-open-failed` (dont délai dépassé) |

- États d'autorisation : `"granted" | "denied" | "restricted" | "prompt" | "unknown"` (`unknown` = valeur iOS inattendue ou plugin muet ; affiché avec son code, I-05 critère 12). `available` = plugin présent **et** `SFSpeechRecognizer(fr-FR)` non nul ; `onDevice` = `supportsOnDeviceRecognition`. `available: true` avec `onDevice: false` **affiche** le bouton (le message du critère 12 doit pouvoir être vu).
- `stoppedBy` : `"user" | "time-limit" | "background" | "interrupted"`.
- **Une écoute à la fois** (`AtomicBool` ; seconde → `speech-busy`, critère 10), drapeau rendu seulement quand l'appel Swift s'est réellement terminé.
- **Limite de 60 s tenue par Rust** : minuteur `tokio::time::sleep(60 s)` qui appelle `stop` (`stoppedBy: "time-limit"`, texte rendu) ; Swift garde une butée propre de 65 s (filet). Délai global de l'appel : 60 s + 10 s, puis `speech-timeout` (section 3.1).
- Journal : rien de Rust ; le front reçoit le code. Aucun texte reconnu, aucun état d'autorisation dans un message d'erreur (critère 10). Aucun fichier créé (test : dossier de données vide après les scénarios du faux transport).

#### 2.2 Plugin Swift `speech` (`src-tauri/plugins/speech/`)

Crate `tauri-plugin-speech`, `links = "tauri-plugin-speech"`, `Builder::new("speech")`, `init_plugin_speech`, `COMMANDS = &[]`. `Package.swift` : `.iOS(.v17)`.

| Méthode | Entrée | Sortie | Rejets |
| --- | --- | --- | --- |
| `status` | — | `{ recognizer, onDevice, microphone, speechRecognition }` | — |
| `requestPermissions` | — | `{ microphone, speechRecognition }` | — |
| `listen` | `{ locale, maxDurationMs }` | `{ text, stoppedBy }` | `invalid-argument`, `microphone-denied`, `speech-recognition-denied`, `on-device-unavailable`, `recognizer-unavailable`, `busy`, `audio-unavailable`, `failed` |
| `stop` | `{ reason }` (`user`, `time-limit`, `background`) | `{ stopped }` | — |
| `openAppSettings` | — | `{ opened }` | — |

- **Files** : `speechQueue` série dédiée pour tout l'état (requête, tâche, moteur, invoke en attente) ; `recognizer.queue` = `OperationQueue` dont `underlyingQueue = speechQueue` (jamais la file principale par défaut) ; activation et désactivation de la session audio sur `speechQueue` (bloquantes, jamais le fil principal) ; seuls `UIApplication.open` et l'observation de l'état de l'app touchent le fil principal. `listen` stocke l'`Invoke` et rend la file `ipc` aussitôt (constat 4) : `stop` peut donc arriver pendant l'écoute.
- **`requestPermissions`** : micro d'abord (`AVAudioApplication.requestRecordPermission`) ; micro refusé → la reconnaissance vocale **n'est pas demandée** ; sinon `SFSpeechRecognizer.requestAuthorization`. Un état déjà décidé n'est jamais redemandé (iOS ne reposerait pas la question). Rend les deux états lus après coup (I-05 critère 5).
- **`listen`**, dans l'ordre : autorisations (`microphone-denied`, `speech-recognition-denied`, `restricted` compris) → reconnaisseur `fr-FR` (`recognizer-unavailable`) → `supportsOnDeviceRecognition` faux → **`on-device-unavailable`, aucune requête créée** → session `.record` / `.measurement` / `.duckOthers`, `setActive(true)` (échec → `audio-unavailable`) → `SFSpeechAudioBufferRecognitionRequest` avec **`requiresOnDeviceRecognition = true`** (affecté une seule fois, jamais remis à faux, aucune autre affectation : contrôle statique), `shouldReportPartialResults = true`, `addsPunctuation = true`, `taskHint = .dictation` → `installTap(onBus: 0, bufferSize: 1024, format: inputNode.outputFormat(forBus: 0))` qui fait seulement `request.append(buffer)` → `engine.prepare()`, `engine.start()` (échec → `audio-unavailable`). Le meilleur texte partiel est gardé **en mémoire** jusqu'à la fin.
- **Fin unique** (`finish(stoppedBy:)`, idempotente) : `engine.stop()`, `removeTap`, `request.endAudio()`, attente du résultat final **au plus 1,5 s** puis `task.cancel()`, `setActive(false, options: .notifyOthersOnDeactivation)`, références remises à `nil` (moteur, requête, tâche, tampon de texte) ; puis `resolve({ text, stoppedBy })`. Erreur de la tâche avant tout texte : `on-device-unavailable` si le modèle a disparu, sinon `failed` ; erreur après du texte : texte rendu avec `stoppedBy: "interrupted"`. « Aucune parole » → `text: ""` (le front l'affiche, section 2.3).
- **Arrêts natifs** (en plus de ceux du front) : `UIApplication.didEnterBackgroundNotification` → `finish("background")` ; `AVAudioSession.interruptionNotification` (`.began`) et `routeChangeNotification` (`oldDeviceUnavailable`) → `finish("interrupted")` ; `mediaServicesWereResetNotification` → rejet `audio-unavailable` après nettoyage. `willResignActive` **n'arrête pas** (Centre de contrôle, bannière) : l'interruption audio couvre l'appel entrant (A5).
- `openAppSettings` : `UIApplication.openSettingsURLString` sur le fil principal, `canOpenURL` puis `open(_:completionHandler:)` ; résout **toujours** `{ opened: success }` (constat 5 corrigé).
- Interdits (contrôle statique, critère 11) : `AVAudioRecorder`, `AVAudioFile`, `FileManager`, `write(to:)`, `URLSession`, `requiresOnDeviceRecognition = false`, toute chaîne française.

#### 2.3 Contrat TypeScript (`src/platform/speech/`), extension additive

```ts
export type SpeechFailure = 'permission-denied' | 'unavailable' | 'failed' | 'on-device-unavailable' | 'busy';
export type SpeechPermissionState = 'granted' | 'denied' | 'restricted' | 'prompt' | 'unknown';
export interface SpeechPermissions {
  readonly microphone: SpeechPermissionState;
  readonly speechRecognition: SpeechPermissionState;
}
export type SpeechStopReason = 'user' | 'time-limit' | 'background' | 'interrupted';

export class SpeechError extends Error {
  readonly reason: SpeechFailure;
  /** Autorisation refusée (`permission-denied` seulement). */
  readonly permission?: 'microphone' | 'speech-recognition';
  /** Code de la commande Rust (affiché et journalisé, jamais un texte reconnu). */
  readonly code?: string;
}

export interface ListenOptions {
  readonly locale: 'fr-FR';
  readonly stopSignal?: AbortSignal;
  /** Cause de la fin d'écoute, appelée avant la résolution de `listen`. */
  readonly onStopped?: (reason: SpeechStopReason) => void;
}

export interface SpeechRecognizer {
  isAvailable(): Promise<boolean>;
  listen(options: ListenOptions): Promise<string>;
  /** État des deux autorisations, relu du système ; absent = aucune autorisation à demander (PC, web). */
  permissions?(): Promise<SpeechPermissions>;
  /** Demande micro puis reconnaissance vocale ; appelée seulement depuis « Continuer » (I-05). */
  requestPermissions?(): Promise<SpeechPermissions>;
  /** Vrai si le modèle français hors ligne est présent. */
  onDeviceReady?(): Promise<boolean>;
  /** Ouvre la page de l'app dans Réglages iOS ; rejette `SpeechError('failed', …, code 'settings-open-failed')`. */
  openSettings?(): Promise<void>;
}
```

- `unavailableSpeech` et le faux existant compilent sans changement ; le faux gagne les quatre méthodes et un journal des appels (I-05 critères 7 et 11).
- Adaptateur **`src/platform/speech/tauriSpeech.ts`**, seul fichier à nommer `speech_*` et `app_settings_open` ; `stopSignal` → `speech_stop` ; codes Rust → `SpeechFailure` (`speech-microphone-denied` → `permission-denied` + `permission: 'microphone'`, `speech-recognition-denied` → `permission-denied` + `permission: 'speech-recognition'`, `speech-on-device-unavailable` → `on-device-unavailable`, `speech-busy` → `busy`, `speech-unavailable` → `unavailable`, le reste → `failed` avec `code`).
- Branchement : `setSpeechRecognizer(createTauriSpeech())` au démarrage sur (`tauri`, `ios`) seulement (`bootstrap`), **sans** lecture d'état ni demande ; prise de développement `globalThis.__ctSpeech`, retirée du build (comme `__ctHaptics`). `isAvailable()` appelle `speech_status` ; plugin muet → `false`, journal `speech-plugin-unavailable` (critère 17).
- Feature (`Dictation.tsx`, `dictationPermission.ts`, i18n `capture.dictation.*`) :
  - appui sur « Dicter » → `permissions()` ; un `prompt` → feuille d'explication (I-05 critère 1) ; « Continuer » → `withExcursion('permission', requestPermissions)` ; `denied` ou `restricted` → message **persistant** (`role="alert"`) nommant l'autorisation, avec « Ouvrir les réglages » (`withExcursion('system-settings', openSettings)`) ; tout autre cas → écoute ;
  - `on-device-unavailable` → message persistant du critère 12 ; `busy`, `failed`, `unavailable`, `unknown` → message persistant avec le code ; texte vide → « Rien n'a été entendu » ; `stoppedBy: 'time-limit'` → « Dictée arrêtée après 60 s » ; `interrupted` → « Dictée interrompue » ; le texte déjà reconnu est toujours posé dans le champ pour relecture, **rien n'est créé** ;
  - écoute en cours : `visibilitychange` masqué et passage du verrou à `locked` (`appLockStore`) → `abort()` (donc `speech_stop`) ; démontage → `abort()` ;
  - retour au premier plan (`visibilitychange` visible) et chaque appui → état relu (`permissions()`), message retiré si l'autorisation est rendue ;
  - échec de `openSettings` → message avec `settings-open-failed`, journalisé (jamais un bouton muet).
- Scan de tâches (I-05 critère 10) : « Ouvrir les réglages » de l'indication caméra appelle **le même** `openSettings` (via le port speech : un seul appel natif vers Réglages) ; si le port n'en a pas (PC, web), l'indication n'est pas affichée. `openCameraSettings` de Y-IOS-02 (barcode-scanner) reste tel quel pour l'écran d'association (hors périmètre).

### 3. Règles transverses

#### 3.1 Appel des plugins avec délai

Nouveau `src-tauri/src/mobile_call.rs` (compilé partout, testé avec un faux) : `call_with_deadline(transport_call, deadline) -> Result<Value, CallError>` lance l'appel bloquant sur un fil dédié et attend par `recv_timeout`. Délai dépassé → `CallError::Timeout` (codes `ocr-unavailable`, `speech-timeout`, `settings-open-failed`) ; le fil reste bloqué jusqu'à la réponse de Swift, le drapeau « occupé » n'est rendu qu'à ce moment (une seconde écoute est refusée `busy`, visible). Délais : Vision `status` 5 s, `recognize` 20 s ; Speech `status` 5 s, `requestPermissions` 5 min (fenêtres d'iOS ouvertes), `listen` 70 s, `stop` 5 s ; `openAppSettings` 5 s.

#### 3.2 Moment des autorisations (I-05)

- Aucune demande au lancement : `bootstrapApp`, `startAppStartup`, effets de montage et synchro n'appellent ni `requestPermissions` ni `speech_request_permissions` (critère 6, liste blanche : `src/features/capture/Dictation.tsx`, `src/platform/speech/tauriSpeech.ts` en plus de celles d'N-01, Y-IOS-02, K-05).
- `speech_status` **lit** seulement (`authorizationStatus`, `recordPermission`) : aucune fenêtre iOS.
- Vision ne demande rien ; la caméra du scan est celle du sélecteur de WKWebView, demandée par iOS au premier « Prendre une photo » (indication du critère 10, état non lisible : A2 d'I-05).

#### 3.3 Excursions du verrou (ADR 0013 §2.4 et avenant I-03 point 3)

| Geste | Excursion | Effet au retour |
| --- | --- | --- |
| « Continuer » (fenêtres micro et reconnaissance vocale) | `permission` | aucune dispense : fenêtres affichées dans l'app ; un vrai passage en arrière-plan suit la règle des 30 s |
| « Ouvrir les réglages » (dictée, indication caméra du scan) | `system-settings` | dispense jusqu'à 5 min si l'app passe en arrière-plan dans les 3 s |
| « Prendre une photo » / « Importer une image » du scan | `camera` | aucune dispense (avenant point 3) |
| Écoute, lecture Vision | aucune | l'écoute s'arrête au passage en arrière-plan |

Un lancement à froid après un changement d'autorisation (constat 9) verrouille comme tout lancement à froid ; l'état est relu au prochain appui.

### 4. Contrats, Info.plist, CI

#### 4.1 Fixtures

`tests/fixtures/capture/vision-contract.json` et `tests/fixtures/capture/speech-contract.json` : méthodes, champs d'entrée et de sortie, codes de rejet, correspondance code Swift → code Rust. Contrôles statiques (`src-tauri/tests/desktop/capture_ios.rs` et `src/platform/capture.ios.consistency.test.ts`) : chaque `@objc public func` Swift et chaque `struct … : Decodable` ↔ fixture ; chaque code `reject` Swift connu de Rust ; aucune chaîne française en Swift ; aucune permission `vision:` ou `speech:` ; crates sous `[target.'cfg(target_os = "ios")'.dependencies]` seulement ; interdits des sections 1.2 et 2.2 ; `requiresOnDeviceRecognition = true` présent une fois et aucune autre affectation.

#### 4.2 Info.plist (`src-tauri/Info.ios.plist`, textes proposés, à relire par Ali, A6 et A4 d'I-05)

| Clé | Texte |
| --- | --- |
| `NSCameraUsageDescription` (élargie) | « CircleTasks utilise la caméra pour scanner le code d'association affiché sur votre PC et pour photographier une liste de tâches à lire. » |
| `NSMicrophoneUsageDescription` (nouvelle) | « CircleTasks utilise le micro seulement pendant que vous dictez une tâche. Rien n'est enregistré. » |
| `NSSpeechRecognitionUsageDescription` (nouvelle) | « CircleTasks transforme votre dictée en texte sur l'iPhone, sans rien envoyer. » |

Aucun `UIBackgroundModes`, aucun droit (entitlement), aucune clé de localisation, de photothèque, de contacts ni de suivi.

#### 4.3 `scripts/ios/plist-contract.json`

- `vision` : `{ story: "CAP-IOS-01", usageDescriptions: ["NSCameraUsageDescription"] }` (la clé sert au sélecteur de photo du scan, pas à Vision ; même clé que `barcode-scanner`).
- `speech` : `{ story: "CAP-IOS-01", usageDescriptions: ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"] }`.
- Champ racine **`forbiddenKeys`** (additif, `formatVersion` inchangé, lu par `check-plist-contract.mjs`) : `UIBackgroundModes`, `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`, `NSContactsUsageDescription`, `NSUserTrackingUsageDescription` (I-05 critère 8, CAP-IOS-01 critère 16).
- Texte en français et mention de la photo d'une liste dans `NSCameraUsageDescription` : test Vitest (`scripts/ios/capIos01.test.ts`) avec entrées négatives (clé retirée, texte vide, texte anglais, clé interdite ajoutée = échec).

#### 4.4 Plugins, capabilities, CI

- `Package.swift` des deux plugins : **`.iOS(.v17)`** (l'app exige 18.0, constat 7) : `AVAudioApplication` sans branche `#available`, aucune API dépréciée.
- `Cargo.toml` de l'app : `tauri-plugin-vision` et `tauri-plugin-speech` (chemins locaux) sous `[target.'cfg(target_os = "ios")'.dependencies]` ; `lib.rs` : `.plugin(tauri_plugin_vision::init()).plugin(tauri_plugin_speech::init())` sous `#[cfg(target_os = "ios")]`.
- Capability **`capture-ios.json`** (`windows: ["main"]`, `platforms: ["iOS"]`), liste exacte : `allow-ocr-status`, `allow-ocr-recognize`, `allow-speech-status`, `allow-speech-request-permissions`, `allow-speech-listen`, `allow-speech-stop`, `allow-app-settings-open`. `ocr.json` reste Windows seulement. Listes contrôlées par `tests/desktop/config.rs`.
- `build-ios.yml`, étape « Plugins iOS » : `tauri-plugin-vision` et `tauri-plugin-speech` ajoutés à la boucle (présents pour `aarch64-apple-ios`, absents pour `x86_64-pc-windows-msvc`) ; étape « Contrat des permissions Info.plist » inchangée (lit le nouveau champ).
- Licence : code propre (aucune entrée à `docs/licences.md`).

## Conséquences

- L'iPhone lit les listes avec Vision (confiance réelle par ligne, seuil de 60 inchangé) et garde tesseract.js en repli **choisi** ; le PC est inchangé (mêmes commandes, `confidence` et `reason` absents de ses réponses).
- La dictée de l'app n'envoie jamais d'audio : sans modèle français sur l'iPhone, elle refuse et le dit ; le micro du clavier iOS reste la voie de secours (sa propre politique réseau relève d'iOS, hors app).
- Un plugin qui ne répond pas ne fige plus l'app : délai Rust, code visible, journal.
- Coût : deux crates Swift (~250 et ~400 lignes), deux modules Rust testés sous Windows, un contrat TS étendu sans casse, une capability, trois clés Info.plist, un champ de contrat. Taille de l'IPA : frameworks du système, aucun modèle embarqué.
- Risques reportés sur l'appareil : confiances Vision en paliers (A1), message du modèle hors ligne quand la dictée iOS est désactivée (A3), texte système de la fenêtre de reconnaissance vocale (écart 4), relance de l'app après un changement d'autorisation (écart 5).

## Écarts avec les fiches (à reporter par le product-owner)

1. **Langues de Vision** : la fiche CAP-IOS-01 (ADR requis, point 1) fixe `recognitionLanguages = ["fr-FR"]` ; la commande de l'architecte demande fr/en. Retenu : `["fr-FR", "en-US"]`, français prioritaire. À confirmer sur A1 ; repli à `["fr-FR"]` sans autre changement si les accents se dégradent.
2. **Codes d'erreur de Vision** : la fiche cite quatre codes (`language-missing`, `unsupported-format`, `too-large`, `failed`) ; le contrat existant en a six (`dimensions` et `unavailable` en plus), tous réutilisés, aucun nouveau.
3. **Plafond d'image** : la fiche dit « 2 000 px au plus, plafond Rust » ; le front réduit à 2 000 px, Rust borne à **4 096 px** de côté et 12 Mio (cas où `prepareImage` rend la source, constat 3). Un plafond Rust à 2 000 refuserait ce cas au lieu de le lire.
4. **Texte d’explication d’I-05 critère 1** (« Rien n’est enregistré ni envoyé ») : la fenêtre système de reconnaissance vocale affiche juste après un texte d’Apple annonçant un envoi de la voix à Apple. **Décision d’Ali (2026-10-08) : le texte de la fiche est conservé** « CircleTasks écoute votre voix pour la transformer en texte, sur l’iPhone. Rien n’est enregistré ni envoyé. iOS vous demandera deux autorisations : le micro, puis la reconnaissance vocale. » ; la reconnaissance étant entièrement sur l’appareil, la fenêtre d’iOS est ignorée. Condition d’Ali : si un chemin pouvait envoyer l’audio, la dictée serait désactivée plutôt qu’un message trompeur ; garanti par `requiresOnDeviceRecognition = true` affecté avant toute requête (une seule affectation), aucune requête si `supportsOnDeviceRecognition` est faux ou si le reconnaisseur est indisponible, et `on-device-unavailable` = dictée désactivée sans tentative (contrôle statique Swift, tests Rust et TS).
5. **I-05 critère 4 et A3** (« retour sans relancer l'app ») : iOS peut terminer l'app quand une autorisation change dans Réglages ; le critère doit accepter un lancement à froid (état relu au prochain appui, verrou à froid si actif).
6. **Ouvrir les réglages** : I-05 critère 4 renvoie au modèle de Y-IOS-02 (`openAppSettings` de barcode-scanner) ; ce dernier peut ne jamais répondre et ignore l'échec (constat 5). Retenu : méthode `openAppSettings` du plugin `speech`, exposée par la commande `app_settings_open`, réutilisée par l'indication caméra du scan (I-05 critère 10) ; l'écran d'association de Y-IOS-02 n'est pas modifié (défaut signalé pour une revue ultérieure).
7. **CAP-IOS-01 critère 17 et I-05 critère 12** (« inscrit au journal, Réglages › À propos › Logs ») dépendent d'**I-04 (lot F)** : sur `lot-c-ios`, `logFailure` n'écrit que dans la console (constat 8). Le message visible avec code suffit à la règle d'Ali en attendant ; le critère « journal » se vérifie après la fusion du lot F (ordre de fusion : F avant C, ou rebasage de C).
8. **I-05 critère 8** exige `NSRemindersFullAccessUsageDescription` au contrat : la clé arrive avec K-05 (`lot-k-ios`), absente de cette branche ; le contrôle complet se fait après la fusion de K.
9. **Liste des sources relues de la fiche** : Q-04 « Réalisation » cite `src-tauri/src/desktop/ocr*` ; le module est `src-tauri/src/ocr/` (aucun effet).
10. **Q-03 critère 6** (« Autorisez le micro dans les Réglages de l'iPhone ») est remplacé sur iPhone par les messages nommés d'I-05 critère 3 ; le test de Q-03 garde le cas générique du faux.

## Fichiers impactés

- Nouveaux : `src-tauri/plugins/vision/{Cargo.toml,build.rs,src/lib.rs,ios/Package.swift,ios/Sources/VisionPlugin.swift}`, `src-tauri/plugins/speech/{Cargo.toml,build.rs,src/lib.rs,ios/Package.swift,ios/Sources/SpeechPlugin.swift}`, `src-tauri/src/ocr/vision.rs`, `src-tauri/src/speech/{mod,ios}.rs`, `src-tauri/src/mobile_call.rs`, `src-tauri/capabilities/capture-ios.json`, `src-tauri/tests/desktop/{capture_ios,speech,ocr_vision}.rs` (+ `main.rs`), `tests/fixtures/capture/{vision,speech}-contract.json`, `src/platform/ocr/nativeOcr.ts` (renommage de `windowsOcr.ts`), `src/platform/speech/tauriSpeech.ts`, `src/platform/capture.ios.consistency.test.ts`, `src/features/capture/dictationPermission.ts` (+ tests), `scripts/ios/capIos01.test.ts`.
- Modifiés : `src-tauri/{Cargo.toml,Cargo.lock,build.rs,Info.ios.plist}`, `src-tauri/src/lib.rs`, `src-tauri/src/ocr/mod.rs`, `src-tauri/tests/desktop/config.rs`, `src-tauri/plugins/README.md`, `scripts/ios/{plist-contract.json,check-plist-contract.mjs}`, `.github/workflows/build-ios.yml`, `src/platform/ocr/{index,types}.ts`, `src/platform/speech/{index,types,testing}.ts`, `src/features/capture/{Dictation.tsx,Dictation.css}`, `src/features/capture/scan/{useScan.ts,ScanDialog.tsx,ScanSource.tsx}`, `src/features/app/bootstrap.ts` (branchement iOS), `src/i18n/{fr,en}.{capture,scan}.ts`, `tests/e2e/{Q-03,Q-04,I-05}.spec.ts`, `docs/stories/_checklist-ordre-5.md` (écarts 4 et 5).
- Inchangés : `src/domain/**`, `src/db/**`, `src-tauri/src/ocr/win.rs`, capability `ocr.json`, plugins existants.
