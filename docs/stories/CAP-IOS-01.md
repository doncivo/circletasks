# CAP-IOS-01 — Plugins Vision (OCR) et Speech (dictée) sur iPhone

Module : M9 Capture rapide · Ordre de construction : 5 (lot C, phase 3, **premier** du lot ; en parallèle du lot F) · Agents : **quick-capture** (contrats TypeScript, écrans, i18n) et **ios-mobile** (Swift des deux plugins, Rust, capabilities, CI) · Relectures : qa-test, code-reviewer, **security-privacy (obligatoire : micro, audio, reconnaissance vocale, image d'une liste)** · Statut : à faire (fiche prête, 2026-10-08)
Story technique du backlog (décision du 2026-10-07). Elle solde Q-04 critère 13 (« Vision remplacera le moteur derrière le même contrat ») et Q-03 critère 5 (« le bouton micro propre à l'app n'est affiché que si `speech.isAvailable()` »), et porte la partie « micro et reconnaissance vocale » d'I-05 (voir I-05).
Dépend de : Q-03 et Q-04 (contrats `SpeechRecognizer` et `OcrEngine`, faux, e2e `iphone`), I-01 (chaîne `build-ios.yml` par branche, contrat Info.plist), I-03 (excursions du verrou), Y-IOS-02 (clé `NSCameraUsageDescription`, schéma « explication puis demande »).

## Rappel

PRD section 7 : OCR iPhone « Vision (plugin Swift, ordre 5), repli tesseract.js » ; dictée iPhone « clavier iOS, plugin Swift (Speech) en option ». Q-03 critère 7 : « aucun enregistrement audio n'est conservé ni envoyé par l'app (pas de service réseau tiers, pas de fichier) ». Q-04 D3 et critère 3 : la photo n'est ni enregistrée ni envoyée.

## À lire avant le code

`docs/adr/0007-build-ios-sans-mac.md` (contrat Info.plist), `docs/adr/0011-synchronisation-icloud.md` §22 points 1 et 2 (plugin appelé par Rust seul, fixture de contrat, aucune chaîne française en Swift) et §23 point 2 (caméra : explication, puis demande), `docs/adr/0013-iphone-gestes-verrouillage-expiration.md` (constat 1 : les méthodes Swift tournent sur une file d'arrière-plan, UIKit et `AVAudioEngine` se pilotent sur la bonne file ; §2.4 excursions, avenant point 3), `docs/stories/{Q-03,Q-04,I-05}.md`, `src/platform/{ocr,speech}/*`, `src/features/capture/{Dictation.tsx,scan/*}`, `src-tauri/src/ocr*` (validation des entrées de Windows), `src-tauri/plugins/folder-bookmark` (modèle), `tests/fixtures/sync/folder-bookmark-contract.json`, `scripts/ios/plist-contract.json`, `src-tauri/Info.ios.plist`, `.github/workflows/build-ios.yml`.

## ADR requis avant le code

**ADR 0015 « Plugins Vision et Speech, autorisations de capture » par l'architecte, avant la première ligne.** (Le numéro 0014 est réservé à l'ADR du journal d'I-04, lot F, pour éviter une collision entre lots parallèles.) Contenu attendu :
1. **Vision** : plugin local `vision`, appelé par Rust seul (aucune permission pour la WebView), derrière les commandes Rust **`ocr_status` et `ocr_recognize` déjà utilisées par Windows** (le TypeScript réutilise `windowsOcr.ts` rebaptisé `nativeOcr`, identifiant `vision` sur iPhone) ; `VNRecognizeTextRequest`, `recognitionLanguages = ["fr-FR"]`, niveau précis, correction linguistique, **confiance par ligne** (0 à 1, ramenée à 0-100) ; image reçue en octets (JPEG ou PNG, 2 000 px au plus, plafond Rust), traitée en mémoire, jamais écrite ; codes `language-missing`, `unsupported-format`, `too-large`, `failed`.
2. **Speech** : plugin local `speech` appelé par Rust seul derrière des commandes Rust (`speech_status`, `speech_request_permissions`, `speech_listen`, `speech_stop`), `SFSpeechRecognizer(fr-FR)` et `AVAudioEngine`, **`requiresOnDeviceRecognition = true` imposé** (aucun audio vers les serveurs d'Apple : Q-03 critère 7) ; modèle hors ligne absent ou dictée désactivée dans iOS = code `on-device-unavailable`, jamais de repli réseau ; arrêt automatique à 60 s en rendant le texte déjà reconnu ; arrêt immédiat au passage en arrière-plan et au verrou ; session audio désactivée et moteur libéré à chaque fin ; aucun fichier audio, aucun tampon conservé ; pilotage sur la file voulue par Apple (leçon du constat 1 de l'ADR 0013).
3. **Contrats, autorisations, CI** : extension **additive** du contrat `SpeechRecognizer` (`permissions()` et `requestPermissions()` distinguant micro et reconnaissance vocale, `SpeechFailure` gagne `on-device-unavailable`) ; fixtures `tests/fixtures/capture/{vision,speech}-contract.json` contrôlées contre le Swift et Rust ; clés Info.plist `NSMicrophoneUsageDescription` et `NSSpeechRecognitionUsageDescription` (nouvelles), `NSCameraUsageDescription` élargie ; entrées `speech` et `vision` du contrat ; `cargo tree --target aarch64-apple-ios` pour les deux crates ; aucun droit (entitlement) ni mode d'arrière-plan.

## Critères testables sans Mac

Légende : **[R]** cargo test, **[U]** Vitest, **[S]** contrôle statique, **[E]** Playwright projet `iphone`, **[CI]** `build-ios.yml` sur la branche du lot.

### Vision (Q-04 sur iPhone)

1. **[U]** **Étant donné** (`tauri`, `ios`), **alors** `openOcrService` rend `primary` = moteur `vision` et `fallback` = tesseract.js ; sur (`tauri`, `windows`) `primary` reste `windows` (tests Q-04 non modifiés) ; sur le web, `primary` est nul.
2. **[U]** **Étant donné** un faux transport Vision renvoyant trois lignes avec confiances 0,95 / 0,40 / 0,80, **alors** `recognize` rend trois lignes aux confiances 95 / 40 / 80, et l'écran de relecture décoche et signale en ambre « Lecture incertaine » la ligne à 40 (Q-04 critère 7, seuil de 60 inchangé).
3. **[R]** **Étant donné** une entrée invalide (image vide, type inconnu, trop lourde, dimensions hors bornes), **alors** Rust rejette `unsupported-format`, `too-large` ou `failed` **avant** d'appeler le plugin ; l'image n'est écrite nulle part (aucun appel d'écriture dans le module, test de compilation sur les imports) et le journal ne reçoit que le code.
4. **[U]** **Étant donné** que Vision rejette `failed`, **alors** l'écran de scan affiche une erreur persistante « La lecture n'a pas abouti » avec « Réessayer » et « Lire avec le moteur intégré » (tesseract) ; **aucun repli silencieux** ; le choix du moteur de repli est explicite.
5. **[S]** **Alors** un test lit le Swift et le Rust : mêmes commandes et champs que la fixture, chaque code de rejet Swift connu de Rust, **aucune chaîne française en Swift**, aucune permission `vision:` dans les capabilities (Rust seul appelle), crate déclaré sous `cfg(target_os = "ios")` seulement, aucune API d'écriture de fichier dans le Swift.
6. **[E]** Projet `iphone` avec `__CT_FAKE_OCR__` : parcours de Q-04 inchangé (critère 13 de Q-04) ; avec un faux « Vision » en échec, le message du critère 4 est visible et « Lire avec le moteur intégré » mène à la relecture.

### Speech (Q-03 sur iPhone)

7. **[U]** **Étant donné** (`tauri`, `ios`) et un faux plugin disponible, **alors** `isAvailable()` est vrai et le bouton « Dicter » s'affiche à droite du champ (feuille Ajout) ; sur (`tauri`, `windows`) et sur le web, le comportement de Q-03 est inchangé ; faux plugin absent : aucun bouton (tests existants).
8. **[U]** **Étant donné** le faux renvoyant « Appeler le plombier demain 9 h », **quand** je touche le micro puis « Terminer », **alors** le texte arrive dans le champ pour relecture, **rien n'est créé** (Q-03 critère 3), la feuille « Je vous écoute » se ferme, le moteur est libéré.
9. **[U]** **Étant donné** une écoute en cours, **quand** l'app passe en arrière-plan (`visibilitychange` masqué) ou que le verrou se ferme, **alors** `speech_stop` est appelé, la feuille se ferme, le texte déjà reconnu est conservé dans le champ s'il n'est pas vide ; **aucune** écoute ne continue app masquée.
10. **[R]** **Alors** les commandes Rust se comportent ainsi avec le faux transport : une seule écoute à la fois (la seconde est refusée `busy`), arrêt à 60 s rendant le texte, `speech_stop` sans écoute en cours sans effet, aucun texte reconnu ni code d'autorisation dans le journal (code d'échec seulement), aucun fichier créé dans le dossier de données.
11. **[S]** **Alors** contrôle statique du Swift et du Rust comme au critère 5, plus : `requiresOnDeviceRecognition = true` présent et jamais remis à faux, aucune écriture de fichier audio, aucun appel réseau.
12. **[U]** **Étant donné** `on-device-unavailable`, **alors** la feuille affiche un message persistant « La dictée hors ligne en français n'est pas disponible sur cet iPhone » avec le chemin « Réglages › Général › Clavier › Dictée » et rappelle que le micro du clavier reste utilisable ; aucun envoi vers le réseau n'est tenté.
13. **[U]** Les états d'autorisation (explication, refus micro, refus reconnaissance vocale, retour des réglages) sont ceux d'**I-05** (critères 1 à 5) ; ils sont testés dans la suite d'I-05 avec le faux de CAP-IOS-01.
14. **[E]** Projet `iphone` avec le faux Speech injecté en développement (`globalThis.__ctSpeech`, retiré du build) : bouton micro, feuille, texte relu, aucune tâche créée ; projet `pc` : aide Win + H inchangée.

### Plateforme et CI

15. **[CI]** `build-ios.yml` vert sur la branche du lot ; `cargo tree --target aarch64-apple-ios -i` montre les deux crates, la cible Windows ne les montre pas.
16. **[CI]** Contrat Info.plist : `NSMicrophoneUsageDescription` et `NSSpeechRecognitionUsageDescription` présentes, non vides, **en français** ; `NSCameraUsageDescription` mentionne le code d'association **et** la photo d'une liste de tâches ; aucune clé en trop (`UIBackgroundModes` absent, aucun droit). Test Vitest du contrat mis à jour avec une entrée négative (clé retirée = échec).
17. **Aucun échec silencieux.** **Étant donné** un plugin absent ou refusé par la capability, **alors** Vision et Speech sont déclarés indisponibles **avec un code visible** : « Scan tâches » garde le repli tesseract (jamais masqué à tort) ; le micro n'est pas affiché, et Réglages › À propos › Logs (I-04) porte l'entrée `speech-plugin-unavailable` ou `vision-plugin-unavailable` (code seul).

## Critères seulement vérifiables sur l'appareil (reportés dans `_checklist-ordre-5.md`)

- A1. Vision : photo d'une page imprimée puis d'une liste manuscrite (stylo noir sur papier blanc, 5 lignes) : lignes lues, confiances plausibles, temps noté (cible < 5 s), comparaison avec le repli tesseract sur la même photo, aucune image retrouvable dans l'app (Fichiers, sauvegardes).
- A2. Speech : dictée « Appeler le plombier demain neuf heures » en français : texte correct dans le champ, aucune création, aucun son enregistré, **mode avion activé : la dictée marche** (preuve du traitement sur l'appareil).
- A3. Dictée sur un iPhone où le modèle français hors ligne n'est pas installé (ou dictée désactivée dans iOS) : message persistant du critère 12, pas d'envoi réseau (mode avion inutile ici : vérifier l'absence de reconnaissance).
- A4. Écoute interrompue : verrouiller l'iPhone ou passer en arrière-plan pendant l'écoute, au retour la feuille est fermée, l'indicateur orange du micro est éteint.
- A5. Appel entrant ou autre app utilisant le micro pendant l'écoute : arrêt propre, texte déjà reconnu conservé, message si besoin.
- A6. Textes des demandes iOS (micro, reconnaissance vocale, caméra) lus en français et conformes.

## Hors de cette story

Appareil photo natif propre à l'app (la photo vient du sélecteur du système, Q-04 critère 13), reconnaissance de l'écriture cursive à haute fiabilité, commandes vocales, Siri, enregistrement ou envoi d'audio, repli de dictée par le réseau, autre langue que le français.

## Ordre des sous-tâches

1. architect : ADR 0015 (avant le code ; le lot F écrit l'avenant ADR 0009 et l'ADR 0014 en parallèle).
2. ios-mobile : crate `src-tauri/plugins/vision` (Swift, `build.rs`), fixture, `ocr_status` / `ocr_recognize` côté iOS, `cargo tree` en CI. quick-capture : `nativeOcr`, `openOcrService`, erreur persistante du critère 4. `build-ios.yml` sur la branche.
3. ios-mobile : crate `src-tauri/plugins/speech`, commandes Rust, `speech_stop` sur arrière-plan et verrou ; Info.plist et contrat. quick-capture : adaptateur `tauriSpeech`, `setSpeechRecognizer` au démarrage iOS, feuille d'écoute, messages (voir I-05).
4. I-05 (critères sur le micro) dans la même branche, puis revue transversale d'I-05.
5. qa-test, code-reviewer, security-privacy ; `build-ios.yml` vert ; checklist d'appareil.
