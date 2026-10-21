# CI-SEC-01 — Clé updater réservée à la signature de l'installeur

## Complément de sécurité TLS — 2026-10-21

**Statut : en cours, avant livraison 1.0.** La CI complète de B5 #72, tête `5c845e67`, est rouge sur deux avis RustSec nouvellement publiés : **RUSTSEC-2026-0382** (`rustls-webpki` 0.103.15) et **RUSTSEC-2026-0383** (`webpki-root-certs` 1.0.9). Preuves rouges : runs **39552278950 / 39552285403**, jobs **119063942988 / 119063961468**, audit actuel non modifié. Les deux avis indiquent une confiance possible dans des intermédiaires emSign révoqués ; aucune exploitation ni atteinte aux données d'Ali n'est affirmée.

Passe product-owner : mettre uniquement les deux dépendances verrouillées à leurs versions corrigées, **0.103.16** et **1.0.10** ; garder les seuils, l'audit obligatoire et l'exception RSA déjà décidée avec sa garde de non-compilation. Aucun changement de fonctionnalité, de secret, de permission ou de catalogue front. Branche propre séparée `ci-sec-01-audit-20261021`, depuis main `dc14badf`, fusion avant B5 pour débloquer sa CI. Estimation **1 h active**, alerte **1,5 h**.

Acceptation : diff du lockfile limité et relu, audit sans ces vulnérabilités, garde RSA conservée, validation des cibles existantes et CI complète verte ; lint, typage et revue consignés, bundle avant push et après fusion. B5 sera mis à jour par fusion de main, sans réécriture de sa branche publiée.

Sources primaires relues : [RUSTSEC-2026-0382](https://rustsec.org/advisories/RUSTSEC-2026-0382.html), [RUSTSEC-2026-0383](https://rustsec.org/advisories/RUSTSEC-2026-0383.html). Le correctif de signature #69 ci-dessous reste acquis ; seule sa preuve de signature de livraison est encore ouverte.

Passe module : `cargo update --precise` pour chacun des deux paquets ; diff limité à **8 lignes** du lockfile (deux versions, deux empreintes), aucun changement de dépendance ni de manifeste. Passe QA : lint global et typage verts ; contrôle Rust `cargo check --locked --tests --features test-hooks` en cours, caches et répertoire temporaire dans le dépôt. L'audit final et tous les tests restent exigés en CI, sans nouvelle exception.

Passe code-reviewer distincte : diff du lockfile relu à froid et comparé aux versions corrigées des deux avis ; **revue du correctif approuvée côté code**. Plages de dépendances inchangées, aucune montée globale, garde RSA et isolation de la clé de signature conservées. Aucun coût front attendu ; bundle avant push et mesure main à consigner. La story n'est pas close sur la seule mise à jour du verrou.

Contrôle Rust local **vert** : `cargo check --locked --tests --features test-hooks`, 9 min 03 s, avec les deux versions corrigées effectivement vérifiées. Lint global et typage verts. Le premier bundle local accuse deux gardes de chemins de la fenêtre d'association : la jonction `node_modules` vers un autre worktree rend ses sources extérieures à la liste blanche. Cause et correction : enlever seulement cette jonction après contrôle du lien et de sa cible interne au dépôt, copier les dépendances dans le worktree ; aucun changement des tests, listes ou seuils. Mesure représentative à refaire avant push, sans relance automatique. L'audit de sécurité final reste attendu en CI.

Module : publication et sécurité · Palier 1.0 · Estimation **3 h actives**, alerte au-delà de **4,5 h** · Statut : fait côté code vérifié et fusionné le 2026-10-20, PR #69 ; signature réelle de livraison à vérifier lors de la publication.

## Passe product-owner

Le workflow Windows transmet aujourd'hui la clé updater et son mot de passe à `tauri build`, qui exécute aussi `beforeBuildCommand` et le build front. Le constat est déjà dans l'audit 1.0, section 5 point 2. Appliquer le périmètre demandé : compiler sans clé, signer le fichier produit dans une étape séparée, puis conserver la vérification hors ligne et les garde-fous de publication. Aucun changement de clé, de politique de publication ni de seuil. N-FIX-02 #68 est en CI ; cette branche touche seulement les fichiers de publication, et sera remise sur main après sa fusion avant tout push.

## Critères

1. Aucun secret `TAURI_SIGNING_PRIVATE_KEY` ou mot de passe dans l'environnement du job, des étapes de dépendances, du build front ou de la compilation NSIS ; les identifiants OAuth déjà autorisés ne changent pas de périmètre.
2. La compilation produit l'installeur sans `createUpdaterArtifacts` ni clé, par la même commande pour un tag et un lancement manuel.
3. Une étape distincte, uniquement sur le push d'un tag de version, reçoit les deux secrets et appelle seulement `tauri signer sign`, avec `--app-version` issu de `check-version.mjs`.
4. Clé absente : échec explicite avant collecte et publication. Aucune valeur de secret dans la ligne de commande ni les journaux ; aucun fichier de clé suivi ou publié.
5. La signature `.sig` rejoint l'installeur ; `verify-signature.mjs` vérifie la clé publique et la version signée avant publication. Le SHA-256, `latest.json`, l'environnement releases et l'interdiction de publier un lancement manuel sont conservés.
6. Lancement manuel : installeur non signé en artefact, aucune publication, comportement conservé. Aucune demande d'installeur manuel à Ali.
7. Preuve rouge sur le workflow actuel avant correctif ; garde sur la portée de toutes les références aux secrets et sur la séparation compilation/signature ; tests de signature existants verts.
8. Vérification locale du vrai CLI installé avec clé et fichier jetables dans le worktree : signature liée à une version, acceptée par le vérificateur existant ; version erronée refusée. Aucune clé réelle utilisée.
9. Lint, typage, revue consignée et suite complète avec couverture verte avant fusion ; bundle avant push puis sur main après fusion, plafond inchangé, aucun coût front attendu.

## Passes et preuves

Clôture du code : #69 fusionnée dans main `ea596996`, tête `99a445fe`, runs **39432599987 et 39432607833**, **48 contrôles verts** avec couverture complète, lint et typage ; revue distincte approuvée. Avant push puis sur main : **58/58 bundle, 338 443 normalisés, 338 378 bruts, marge 19 957**, coût nul. Les étapes ci-dessous conservent la chronologie et les preuves rouges ; la signature de l'installeur publié reste une preuve de livraison, distincte du banc à clé jetable déjà vert.

Product-owner : périmètre ci-dessus approuvé pour implémentation, aucune décision rouverte. Tests rouges, agent du module, qa-test, revue et CI à consigner au fur et à mesure. Aucun statut « fait » à ce stade.

Preuve rouge **`f986b2f5`** : garde du workflow actuel, **trois échecs / un succès**, dont la présence effective des variables privées dans l'étape de compilation. Le test de collecte et de vérification existante passe déjà. Le correctif retire les secrets de la compilation et signe ensuite le même fichier, avec version liée, dans une étape réservée aux tags.

Passe qa-test : **18 tests / deux fichiers de publication verts**, couverture coupée ; garde de portée de toutes les références, ordre compilation → signature → collecte, refus de clé absente, absence de compilation dans l'étape de signature, configuration globale sans artefacts signés au build, vérification et SHA-256 conservés. Le vrai CLI installé a généré une clé jetable dans le worktree, signé un fichier factice en version 1.2.3 puis passé le vérificateur existant : génération **0**, signature **0**, vérification 1.2.3 **0**, version 1.2.4 refusée **1**. Les fichiers jetables ont été effacés après contrôle du chemin dans le worktree ; aucune clé réelle ni valeur de clé affichée. Une première configuration du banc avait posé à vide une variable de chemin de clé qui entrait en conflit avec la clé en chaîne ; le banc retire désormais cette variable, absente du workflow réel. Aucun délai, timeout ni relance automatique ajouté.

Lint final et typage, revue distincte, remise sur main après #68, mesure avant push et CI complète encore attendus. La compilation et signature réelles du NSIS de livraison restent celles du tag de livraison ; aucun installeur n'a été lancé sur le PC d'Ali.

Passe code-reviewer distincte sur `92d0e928` et la garde finale : **approuvée côté code** après qa-test et relecture du diff à froid. Portée des secrets limitée à l'étape de signature, clé absente refusée, `--app-version` vérifié avec le vrai CLI, aucune compilation dans cette étape ; collecte, vérification publique, version, empreinte, conditions de publication et cache de tag conservés. La configuration globale ne demande pas d'artefacts signés au build. Lint global final vert après écriture des espaces du motif sous la forme `{6}` ; 18 contrôles de publication verts. Remise sur main, typage du build, bundle avant push et suite complète avec couverture restent requis ; aucune clôture revendiquée avant ces preuves.

Remise sur main `f06bdee5` après fusion de #68, avant toute publication de cette branche. Deux conflits de journal résolus en conservant les sections N-FIX-02 et CI-SEC-01 ; aucun conflit de code. Les commits deviennent **`a63dfbc9`** (rouge), **`e1643aef`** (correctif), **`9f15c037`** (revue). Les blobs du workflow rouge et du test rouge sont identiques avant et après rebase, vérifiés par leurs identifiants Git ; les preuves historiques restent donc reproductibles dans l'historique publié. Relecture du diff sur ce main : mêmes changements de publication, aucune modification du module de rappels fusionné. Budget de référence avant cette story : **338 443**, marge **19 957** ; mesure de la branche avant push encore requise.
