# CI-WEBKIT-01 — Cache des dépendances système de WebKit et délai propre à l'étape

Module : M16 publication et CI · Palier : outillage, hors version publiée · Agent : ci-release · Ouverte le 2026-10-27 par Claude Code, sur décision d'Ali du 2026-10-27 au soir (« le cache WebKit — pas de test rouge, la preuve est une mesure du temps d'installation avant et après, plus un délai propre à ce job »).

Statut : **en cours** — workflow modifié sur la branche `ci-webkit-01-cache`, mesure « avant » consignée, mesure « après » attendue de la CI de la branche (premier run à cache froid, deuxième à cache chaud). Estimation : 1 h 30 active hors attente CI ; alerte à 2 h 15.

## Constat (job `e2e iphone-webkit`, `.github/workflows/tests.yml`)

Le navigateur WebKit de Playwright est en cache (`~/.cache/ms-playwright`, clé par `package-lock.json`) mais ses **paquets système** ne le sont pas : à chaque run, `npx playwright install-deps webkit` télécharge du miroir Ubuntu du runner **187 paquets `.deb`, 117 Mo** (6 mis à jour, 181 nouveaux), avant tout test. Quand le miroir `azure.archive.ubuntu.com` traîne, le téléchargement n'aboutit pas dans les 20 minutes du job et celui-ci est annulé sans avoir lancé un seul test. Journal du job 122352043390 (run 40550343167, PR #94) : `apt-get update` en 1 s, puis `fonts-freefont-ttf` (5,6 Mo) en 100 s, 63 paquets sur 187 reçus en 19 minutes, annulation à 20 min 17 s.

## Décision d'Ali (2026-10-27)

Pas de test rouge : la preuve est la mesure du temps de l'étape avant et après, plus un délai propre à cette étape. Ce délai n'est pas celui d'un test : la règle « aucun délai ajouté, aucun timeout allongé » d'`AGENTS.md` porte sur les tests ; ici le délai **borne** une installation de paquets pour qu'elle échoue vite au lieu de consommer le job, et il reste à relancer à la main (`gh run rerun <run> --failed`), aucune relance automatique.

## Critères

1. Les `.deb` demandés par Playwright pour WebKit sont conservés d'un run à l'autre (`actions/cache`, chemin `~/.cache/ct-apt-webkit`, clé : image du runner `ImageOS-ImageVersion` et empreinte de la liste de paquets donnée par `npx playwright install-deps --dry-run webkit` ; `restore-keys` sur l'image seule).
2. Avant l'installation, les `.deb` restaurés sont recopiés dans `/var/cache/apt/archives/` ; `install-deps` garde son `apt-get update` et apt n'en télécharge que ce que l'index ne confirme plus (paquet mis à jour entre-temps). Après l'installation, les `.deb` du cache apt sont recopiés dans le dossier mis en cache.
3. L'étape « Dépendances système de WebKit » porte `timeout-minutes: 5` (nominal observé 26 à 67 s), tourne toujours (plus de condition sur le cache du navigateur) et affiche le nombre de `.deb` restaurés, la durée de l'installation et le nombre de `.deb` conservés. « Installer WebKit » ne fait plus que `npx playwright install webkit` quand le navigateur n'est pas en cache.
4. Le job garde ses 20 minutes, ses tests, son comptage et ses artefacts ; aucun test, aucun seuil, aucune relance automatique touchés. Les jobs Chromium ne changent pas (leurs dépendances système sont pour l'essentiel déjà dans l'image du runner).
5. Preuve : tableau avant / après ci-dessous, run par run, à partir des durées d'étape de l'API GitHub.

## Mesure « avant » (25 derniers runs de `tests.yml` au 2026-10-27, étape « Dépendances système de WebKit »)

| Issue | Runs | Durée de l'étape |
| --- | --- | --- |
| Réussie, miroir normal | 16 runs (40550351616, 40550343167 relancé, 40543874743, 40543864631, 40543852280, 40543241644, 40541625751, 40541014897, 40539566399, 40539070184, 40538972771, 40534512313, 40534500356, 40530354932, …) | **26 à 67 s** (médiane 30 s) |
| Réussie, miroir lent | 40539059785 | 305 s |
| Annulée pendant le téléchargement | 40550343167 (job 122352043390, PR #94), 40550331770, 40537316409, 40536780166, 40528597883 | 1197 s, 1197 s, 819 s, 822 s, 596 s (les trois dernières annulées par la concurrence d'un nouveau push alors que le téléchargement traînait encore) |

Trois annulations à 20 min 17 s le 27 octobre ont chacune coûté une relance manuelle et vingt minutes d'attente sur une PR prête.

## Mesure « après »

À consigner après les deux premiers runs de la branche : run à cache froid (téléchargement puis sauvegarde du cache) et run à cache chaud (restauration, aucun téléchargement attendu hors paquets mis à jour entre-temps). Puis premier run de `main` après fusion (cache froid côté `main`, les caches de branche ne lui étant pas visibles) et le suivant.

## Passes

- **Product-owner** : périmètre limité au job WebKit et aux fichiers de CI et de documentation ; aucun code applicatif, aucun test touché ; critères ci-dessus.
- **Agent du module (ci-release)** : `tests.yml`, job `e2e-webkit` seulement (étape de clé, cache des `.deb`, étape d'installation avec délai et mesure, installation du navigateur seul). Commentaire du workflow renvoyant à cette fiche.
- **QA** : pas de test rouge (décision d'Ali) ; vérification du YAML par l'exécution du workflow sur la branche ; mesure avant / après consignée run par run.
- **Code-reviewer** : à consigner après la mesure « après ».

Bundle de départ : l'arbre `src/` de la branche est identique à celui de `main` 89a1f9c6, mesuré le 2026-10-27 à **335 256 normalisés, marge 23 144** ; aucun fichier du front touché.
