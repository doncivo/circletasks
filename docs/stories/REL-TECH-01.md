# REL-TECH-01 — Test de fumée du binaire Windows

Module : Livraison unique · Ordre de construction : transverse (avant REL-01) · Agent : **ci-release + qa-test** · Statut : en cours (2026-10-10, branche smoke-windows)
Story technique, sans équivalent au PRD (écart noté dans docs/decisions.md, 2026-10-10). Décision d'Ali du 2026-10-10 : « Ajoute un test de fumée qui lance le vrai binaire Windows et vérifie que l'écran du jour s'affiche. Un écran noir au démarrage ne doit jamais pouvoir passer inaperçu. »
Dépend de : A-01 (écran du jour), guide de bienvenue, build Tauri PC. Ne touche ni `src/domain` ni `src/db`.

## Contexte

- Le 2026-10-10, Ali a vu une fenêtre entièrement noire au démarrage de la 0.3.1 en dev. Diagnostic : aucune régression du code (le journal technique prouvait un démarrage complet) ; cause environnementale WebView2 (mise à jour du runtime à 3 h 23) ; après redémarrage, l'app s'ouvre.
- Aucun test existant ne pouvait le voir : les e2e `pc` tournent dans Chromium/WebKit via Playwright contre Vite, jamais dans la fenêtre Tauri réelle ; `cargo test` n'ouvre pas de fenêtre.
- Un test du DOM seul ne suffit pas (le DOM peut être correct dans une fenêtre noire) : le test regarde aussi les pixels réels de la fenêtre.

## Critères testables

### Build du binaire de fumée

1. **Étant donné** `npm run test:smoke:build` (`node scripts/smoke/build.mjs` : `tauri build --debug --no-bundle --config src-tauri/tauri.smoke.conf.json` avec `CARGO_TARGET_DIR=src-tauri/target/smoke`), **quand** il s'exécute, **alors** il produit `src-tauri/target/smoke/debug/circletasks.exe` avec les ressources du front embarquées (aucun serveur Vite nécessaire), dans un dossier cargo dédié : jamais le binaire de `tauri dev` (`target/debug`), qui peut tourner pendant le test en local.
2. **Étant donné** la configuration `src-tauri/tauri.smoke.conf.json`, **alors** l'identifiant est `fr.circletasks.planner.smoke` : le dossier de données AppData et le verrou mono-instance sont distincts de ceux de l'app installée et de l'app de dev (le test ne touche jamais aux données d'Ali et ne se heurte pas à une instance ouverte).
3. **Alors** la fenêtre principale porte `additionalBrowserArgs` avec `--remote-debugging-port=9377` ; la variable d'environnement `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` n'est pas utilisée (WebView2 l'ignore quand wry fixe ses arguments, constaté le 2026-10-10).
4. **Alors** la configuration de fumée n'altère ni `tauri.conf.json` ni les builds de dev et de livraison.

### Test

5. **Étant donné** `npm run test:smoke` (Playwright, `playwright.smoke.config.ts`, dossier `tests/smoke`, 1 worker, 0 nouvel essai, aucun `webServer`), **quand** le test démarre, **alors** il efface le dossier de données smoke (vrai premier lancement) puis lance le binaire.
6. **Quand** il se connecte par CDP (`chromium.connectOverCDP`, port 9377), **alors** il attend `.app-shell[data-db-status="ready"]` dans un délai borné ; un dépassement est un échec explicite (jamais un test relancé ou un délai allongé).
7. **Quand** le guide de bienvenue s'affiche, **alors** le test clique « Passer le guide de bienvenue ».
8. **Alors** l'écran du jour est vérifié : onglet Tâches courant, titre `h1` du jour (jour local de la machine), badge « Aujourd'hui », absence de tout `role=alert`.
9. **Étant donné** la fenêtre Win32 du processus lancé, **quand** `tests/smoke/window-capture.ps1` la capture (PrintWindow, pixels réels), **alors** le test échoue si la fenêtre est absente, invisible, réduite, plus petite que 1024×700, ou si 95 % ou plus des pixels échantillonnés sont quasi noirs (max(R,G,B) < 12).
10. **Alors** l'image capturée est jointe au rapport Playwright, en cas de réussite comme d'échec.
11. **Étant donné** que l'app se cache dans la zone de notification à la fermeture, **alors** le processus est tué à la fin du test, y compris sur échec ; aucun `circletasks.exe` de fumée ne reste actif.
12. **Étant donné** une fenêtre noire simulée (DOM correct mais rendu vide), **alors** le contrôle des pixels (critère 9) échoue : preuve que le test détecte le défaut d'origine (test du script de capture sur une image noire et sur une image normale).
13. **Alors** aucun échec n'est silencieux : un échec de lancement, de connexion CDP ou de capture est un échec du test avec son message, jamais un test ignoré.

### CI

14. **Étant donné** `.github/workflows/tests.yml`, **alors** le job `smoke-windows` (`windows-latest`) construit le binaire de fumée puis lance `npm run test:smoke`, sur un runner dédié et parallèle aux autres jobs.
15. **Alors** `smoke-windows` est requis par le statut « suite verte » : une fusion dans main attend ce job vert.
16. **Alors** en cas d'échec, les artefacts (rapport Playwright et capture de la fenêtre) sont conservés.

## Limites assumées

- Build debug, pas l'installeur NSIS signé (l'installation et la mise à jour restent couvertes par REL-03 et la séance finale).
- Thème système du runner (clair ou sombre) : le seuil de 95 % de pixels quasi noirs reste valable pour un thème sombre de l'app dont le fond n'est pas noir pur.
- Les autres fenêtres (Capture rapide, Focus) ne sont pas vérifiées.
- CPU du runner : délais bornés mais généreux, jamais allongés pour masquer un échec.

## Hors de cette story

- Parcours fonctionnels sur le binaire réel (REL-01) ; iPhone (aucune commande iOS locale, build-ios.yml).
- Correction de la cause WebView2 (environnementale) : le test la détecte, il ne la corrige pas.
- Toute fonction de la liste « Hors périmètre » du PRD.

## Vérifications

- Local : `npm run test:smoke:build` puis `npm run test:smoke` (module en cours seulement, pas la suite complète) ; lint et typage verts.
- CI : job `smoke-windows` vert sur la branche, statut « suite verte ».
- Preuve de détection : critère 12 (image noire refusée), capture jointe au rapport.
- Revue : code-reviewer approuve ; aucun fichier écrit hors du dépôt ; aucun secret.
- Clôture refusée si un critère manque : le product-owner vérifie les 16 critères avant « fait ».
