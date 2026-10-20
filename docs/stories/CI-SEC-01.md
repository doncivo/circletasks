# CI-SEC-01 — Clé updater réservée à la signature de l'installeur

Module : publication et sécurité · Palier 1.0 · Estimation **3 h actives**, alerte au-delà de **4,5 h** · Statut : en cours, passe product-owner du 2026-10-20.

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

Product-owner : périmètre ci-dessus approuvé pour implémentation, aucune décision rouverte. Tests rouges, agent du module, qa-test, revue et CI à consigner au fur et à mesure. Aucun statut « fait » à ce stade.

Preuve rouge **`f986b2f5`** : garde du workflow actuel, **trois échecs / un succès**, dont la présence effective des variables privées dans l'étape de compilation. Le test de collecte et de vérification existante passe déjà. Le correctif retire les secrets de la compilation et signe ensuite le même fichier, avec version liée, dans une étape réservée aux tags.

Passe qa-test : **18 tests / deux fichiers de publication verts**, couverture coupée ; garde de portée de toutes les références, ordre compilation → signature → collecte, refus de clé absente, absence de compilation dans l'étape de signature, configuration globale sans artefacts signés au build, vérification et SHA-256 conservés. Le vrai CLI installé a généré une clé jetable dans le worktree, signé un fichier factice en version 1.2.3 puis passé le vérificateur existant : génération **0**, signature **0**, vérification 1.2.3 **0**, version 1.2.4 refusée **1**. Les fichiers jetables ont été effacés après contrôle du chemin dans le worktree ; aucune clé réelle ni valeur de clé affichée. Une première configuration du banc avait posé à vide une variable de chemin de clé qui entrait en conflit avec la clé en chaîne ; le banc retire désormais cette variable, absente du workflow réel. Aucun délai, timeout ni relance automatique ajouté.

Lint final et typage, revue distincte, remise sur main après #68, mesure avant push et CI complète encore attendus. La compilation et signature réelles du NSIS de livraison restent celles du tag de livraison ; aucun installeur n'a été lancé sur le PC d'Ali.
