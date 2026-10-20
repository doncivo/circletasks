# Y-IOS-02-FIX-01 — Échec de suppression de l'époque orpheline affiché avec sa cause

Module : M15 Synchronisation · Ordre de construction : 5 (correctifs de la séance iPhone 0.3.0, **avant REL-01**) · Agents : **sync-icloud** (moteur `src/sync/`, domaine, écran de Détails, bandeau) et **ios-mobile** (vérification sur l'iPhone, e2e `iphone`) · Relectures : qa-test, code-reviewer · Statut : en cours (2026-10-19) ; preuves rouges consignées, QA locale et revue finale en cours ; CI et essai appareil requis avant clôture
Correctif rattaché à **Y-IOS-02** (abandon de l'époque orpheline, ADR 0011 §24 point 4 (e)). Aucun écart au PRD ; ajoute un avertissement de plus à l'écran de Détails et aux bandeaux A-09.
Dépend de : Y-IOS-02 (fait), Y-07 (statuts, textes de motifs de synchro), A-09 (bandeaux), Y-10-FIX-01 (aucune dépendance de code, mais même écran : fusionner dans l'ordre de la phase). Ne bloque aucune autre story.

## Contexte

### Passe product-owner du 2026-10-19 — périmètre étendu autorisé

Début de reprise après `main` `5d7bb1a4`. Estimation du périmètre étendu : **4 à 6 h**, arrêt et alerte à **9 h**. Statut courant : en cours, aucune validation revendiquée. Les décisions déjà prises restent appliquées : écrivain unique, format inchangé, publication et lecture non bloquées par l'entretien, aucune lecture iCloud pour écrire.

Aux critères historiques s'ajoutent B5 réduit (`delete-own-failed`, segments, instantanés et anciennes époques) et les défauts 2 et 3 connus du banc Y-TECH-03 : un ancien instantané qui revient après une suppression acceptée doit produire un échec durable visible et être retenté sans attendre une nouvelle création d'instantané ; un substitut qui reste malgré une réponse sans suppression ne doit plus permettre « À jour ». Ces preuves sont établies sur le banc, sans données réelles.

Le suivi local conserve la preuve des suppressions demandées et des échecs au redémarrage. Les échecs ne disparaissent qu'au succès ou à la confirmation de l'absence ; une disparition temporaire du listing ne doit pas faire oublier qu'un fichier revenu avait déjà été supprimé. Aucune reprise automatique supplémentaire en dehors des cycles existants. Les critères d'interface s'appliquent aux deux familles d'échecs avec cause traduite, dernier essai et action manuelle. Les essais physiques de clôture seront regroupés après publication de l'IPA : jusque-là, le statut sera « code vérifié, essai appareil en attente ».

Constat de la séance iPhone 0.3.0 (2026-10-10) : après l'abandon de son époque orpheline, le fichier `s-00000001.cts` de l'ancienne époque de l'iPhone est **resté** dans `devices/<iPhone>/e0001-<iPhone>/` du dossier iCloud. La suppression (`retryOrphanDeletion` de `src/sync/orphanEpoch.ts`) a échoué ; le moteur journalise `orphan-epoch-delete-failed` avec son code et la retente à chaque cycle, **mais rien n'est montré à l'utilisateur**. Or tant que ce fichier existe, `canPublish` (`src/domain/sync/epoch.ts`, `listedFiles`) refuse la publication, et l'iPhone n'affiche que « Cet appareil n'a pas encore publié son état : vos autres appareils ne voient pas ses modifications », **sans dire pourquoi**. C'est un blocage durable sans cause visible, contraire à la règle d'Ali « aucun échec silencieux » (mémoire projet : tout blocage durable visible dans l'app, pas seulement dans les logs).

**Mise à jour du 2026-10-16** : la séance 0.3.2 a montré que la prémisse « le moteur retente et journalise » était fausse dans le cas réel (le mémo `orphanEpoch` avait été effacé alors que le fichier restait) ; la cause du blocage est corrigée par **Y-IOS-02-FIX-02**, qui lève le « `canPublish` inchangé » de cette fiche ; la présente story reste utile pour afficher un échec de suppression (statut inchangé : à faire).

Rappel du mécanisme : `sync_meta.orphanEpoch` (`META.orphanEpoch`, `{ epoch }`) est posé à l'abandon et effacé à la suppression réussie, ou quand l'époque n'est plus listée (`orphan-epoch-cleared`). L'échec n'est aujourd'hui gardé nulle part : il faut le persister.

## Références visuelles

Aucune maquette. Composé avec les éléments existants : ligne d'avertissement de Détails (même famille que « Cet appareil n'a pas encore publié son état »), bandeau A-09, `Button` secondaire. Aucun élément visuel nouveau ; relu par Ali sur l'iPhone.

## Critères testables

Tests : Vitest (moteur sur faux `SyncFs` et horloge injectée, écran avec Testing Library), Playwright projet `iphone`. Références : ADR 0011 §24 point 4 (e), §10.4 sur les codes.

### Mémorisation de l'échec (moteur)

1. **Étant donné** `sync_meta.orphanEpoch` posé et un fichier de l'ancienne époque que `deleteOwn` ne peut pas supprimer (code `E`), **quand** `retryOrphanDeletion` échoue, **alors** il écrit dans `sync_meta` une clé dédiée (`orphanDeleteFailure`, `{ code, at }` : code d'erreur existant parmi les 38, heure ISO ; jamais de chemin, de nom de fichier, de clé ni de contenu), en plus du journal `orphan-epoch-delete-failed` (inchangé).
2. **Alors** chaque nouvel échec **met à jour** `code` et `at` (« dernier essai ») ; l'échec est relu au démarrage depuis `sync_meta` (persistant après redémarrage, avant le premier cycle).
3. **Alors** l'échec est **effacé** quand et seulement quand : la suppression réussit (`orphan-epoch-deleted`), ou l'époque n'est plus listée (`orphan-epoch-cleared`), ou `sync_meta.orphanEpoch` est effacé par un autre chemin (abandon refusé, `state-mismatch`) ; jamais par le passage du temps ni par un redémarrage.
4. **Alors** une interruption de cycle (`isCycleInterrupted`) n'est **pas** comptée comme un échec (pas de mémo, comportement actuel conservé) ; test.
5. **Alors** la lecture et la publication ne sont toujours pas retardées par cette suppression (comportement actuel de `retryOrphanDeletion` conservé) ; `canPublish` reste inchangé : la story rend la cause visible, elle ne change pas la règle de publication.

### Affichage

6. **Étant donné** `orphanEpoch` posé **et** un échec mémorisé, **alors** `status()` expose l'état (champ dédié de `SyncStatus`, par exemple `orphanDelete: { code, at, folderHint } | null`) et Réglages > Synchronisation > Détails montre, en rouge, `role="status"` : « Les fichiers de l'ancienne époque de cet appareil n'ont pas pu être supprimés : {cause} » suivi de « Dernier essai à {heure} » (24 h).
7. **Alors** `{cause}` est le **code traduit comme les autres motifs de synchro** (même table `src/i18n` que les motifs de `syncText.ts`, pas de table parallèle) ; un code inconnu donne le texte générique de cette table, jamais le code brut seul ni une cause inventée.
8. **Alors** le texte indique le **chemin exact** du dossier à vérifier dans l'app Fichiers : `CircleTasks › devices › {identifiant court de l'appareil} › {époque}` (D1), construit à partir de l'identifiant de l'appareil local et de l'époque de `orphanEpoch` (des identifiants, pas un chemin système), sans aucun bouton de suppression.
9. **Alors** l'avertissement est aussi porté par un **bandeau A-09** (`src/domain/syncBanners.ts`, une ligne de correspondance de plus, test d'exhaustivité phase / état vers bandeau mis à jour) tant qu'il dure ; le bandeau renvoie vers Détails ; priorité : sous les bandeaux qui empêchent de synchroniser (`needs-pairing`, `forgotten`, clé manquante), au-dessus de « Cet appareil n'a pas encore publié son état ».
10. **Alors**, quand « Cet appareil n'a pas encore publié son état » est affiché **en même temps**, la cause est lisible sans quitter l'écran : l'avertissement de l'orpheline vient juste au-dessus ou dans la même zone ; test d'écran avec les deux états.
11. **Alors** l'avertissement **disparaît** dès que l'échec est effacé (critère 3), sans redémarrage, et n'apparaît jamais si `orphanEpoch` est posé sans échec journalisé (suppression pas encore tentée ou en cours) : pas d'alarme sur un état normal.

### Action

12. **Quand** je touche « Réessayer maintenant », **alors** un cycle de synchro est lancé (`syncNow('manual')`, comme le « Réessayer » des autres échecs de synchro) et `retryOrphanDeletion` est rappelé dans ce cycle ; aucun appel direct à `deleteOwn` depuis l'écran, aucune boîte native, aucune écriture dans `devices/` d'un autre appareil.
13. **Alors** pendant le cycle le bouton est désactivé et `aria-busy` ; au terme, l'avertissement se met à jour (nouvelle heure, nouveau code) ou disparaît ; bouton avec nom accessible ; jamais de reprise automatique supplémentaire autre que le cycle normal déjà existant.

### Qualité

14. **Alors** tous les textes sont dans `src/i18n` (fr et en, parité vérifiée) ; aucun texte en dur ; heures en 24 h ; thèmes clair et sombre ; aucune boîte bloquante.
15. **Alors** aucun journal ni `console.*` ne contient de clé, de titre ni de chemin système ; le journal garde seulement `orphan-epoch-delete-failed { code }` ; l'écriture de `orphanDeleteFailure` qui échoue elle-même n'est pas avalée (erreur propagée au cycle, qui la rapporte comme les autres échecs de `sync_meta`).
16. **Alors** aucun test ne dépend d'un délai réel (horloge injectée, faux `SyncFs` qui échoue puis réussit, aucun `setTimeout` ni `sleep`).
17. **Alors** la story n'ajoute **aucune migration** (une clé de `sync_meta` de plus, table locale jamais publiée), aucune commande Rust, ne change ni `sm` ni le format sur disque, et laisse `config.rs` inchangé.

### Clôture

18. **Alors** la story ne passe « fait » qu'avec les critères 1 à 17 verts, les tests Vitest du moteur et de l'écran verts, l'e2e `iphone` vert (échec simulé, avertissement, « Réessayer maintenant », résolution), la suite verte en CI, et le cas réel vérifié sur l'iPhone (checklist de l'ordre 5).

## Hors de cette story

- Supprimer le fichier à la place de l'utilisateur depuis le PC ou depuis l'app (aucun accès aux dossiers d'un autre appareil, règle d'écrivain unique, ADR 0011 §1.1) : voir D1.
- Corriger la cause de l'échec de suppression elle-même sur iPhone (fichier iCloud non téléchargé, verrou, signet) : à diagnostiquer avec le code affiché ; correctif distinct si la cause est un défaut.
- Changer la règle `canPublish` / `listedFiles` : inchangée.
- Abandon de l'époque orpheline lui-même (Y-IOS-02) : inchangé.

## Décisions (options recommandées ; lignes ajoutées à docs/decisions.md)

- D1 — **Point ouvert tranché** : pas de « Supprimer moi-même » ni de bouton de suppression côté PC. Le texte donne le **chemin exact** du dossier à vérifier dans l'app Fichiers (recommandation d'Ali), sans lien ni suppression par l'app : cohérent avec la règle d'écrivain unique, sans surface de suppression nouvelle, et la suppression manuelle dans Fichiers reste une action de l'utilisateur. Le chemin affiché reste fait d'identifiants, jamais d'un chemin système ni du nom d'un fichier. À valider par Ali avec la story.
- D2 — Une seule clé de `sync_meta` (`orphanDeleteFailure`), effacée à la résolution, comme `forgetFailure` : même schéma que Y-10, aucune table nouvelle.

Avenant du 2026-10-19 au périmètre autorisé : `orphanDeleteFailure` garde ce rôle pour l'orpheline ; `ownDeleteFailure` couvre les autres suppressions et `ownDeletionReceipts` conserve les références demandées, y compris après une absence temporaire. Ces trois valeurs restent locales dans la table existante, sans migration ni format publié nouveau. Aucun changement de décision produit.

## Fichiers

`src/sync/orphanEpoch.ts` (`retryOrphanDeletion`) et `src/sync/meta.ts` (clé) ; `src/sync/engine.ts` (lecture dans `status()`) ; `src/platform/sync/types.ts` (champ de `SyncStatus`) ; `src/features/sync/syncText.ts` (cause traduite, réutilisée) ; `src/features/sync/SyncDetailsScreen.tsx` ou composant dédié de Détails ; `src/domain/syncBanners.ts` (une ligne) ; `src/i18n/{fr,en}*` (section de synchro) ; tests `tests/unit/sync/**`, tests d'écran et `tests/e2e/parcours/` (parcours iPhone de synchro).
**Lus, jamais modifiés** : `src/domain/sync/epoch.ts` (`canPublish`), Rust (`src-tauri/src/sync/**`).

## Ordre des sous-tâches

1. sync-icloud (moteur) : `orphanDeleteFailure` écrit, mis à jour, effacé ; `status()` ; tests Vitest du moteur (critères 1 à 5, 15, 16).
2. sync-icloud (interface) : avertissement de Détails (cause traduite, chemin, heure), « Réessayer maintenant », bandeau A-09 (critères 6 à 14).
3. sync-icloud puis ios-mobile : e2e `iphone` (échec simulé, avertissement, nouvelle tentative, résolution, redémarrage) ; qa-test ; code-reviewer ; product-owner vérifie critère par critère et clôt.

## Vérifications manuelles d'Ali (iPhone, ordre 5)

### Passes de QA et de revue du 2026-10-19

- Preuves rouges : `4d1d9bfd` (scénario 4 historique, deux échecs), `69e8a188` (substitut persistant et retour d'instantané, cycles du banc explicitement avancés), `429921e6` (bandeau absent pendant le premier cycle après restauration).
- Preuves vertes : `6ef9ac6a` pour le moteur, la persistance et l'interface ; `0f838da6` pour le bandeau au démarrage. QA ciblée sans couverture : 142 tests verts sur 15 fichiers, puis 32 tests verts sur les deux fichiers de persistance et de bandeaux après le dernier correctif. E2e `iphone` sur `0f838da6` : 1/1 vert, 11,1 s, cause, dossier, bouton occupé et résolution.
- Revue distincte : diff complet relu depuis `origin/main`, puis seconde lecture des chemins de stockage, de restauration et d'entretien. Les exceptions du stockage remontent ; l'interruption ne crée pas d'échec ; un reçu ne donne aucun droit de suppression supplémentaire ; les critères d'éligibilité restent ceux du moteur. Aucun changement de format, de migration, de Rust ni de `canPublish`. Le signal restauré est présent même pendant le premier cycle. Composant et catalogues dédiés à la demande, assertion hors départ ajoutée. **Revue du code approuvée**, sous réserve des contrôles finaux et de la CI complète obligatoire.
- Le critère 18 reste ouvert jusqu'à l'essai physique du lot IPA ; aucune clôture « fait » revendiquée.
- Contrôles finaux avant push : lint et typage verts ; bundle **55/55**, **342 977 octets normalisés**, 342 917 bruts, marge 15 423 sur 358 400, garde d'écart 60/100. Aucun seuil modifié, aucun module ajouté à la liste du départ. CI complète avec couverture encore requise avant fusion.
- Première CI de #65 (`39276679969`, `3b0ee1f3`) : garde du formateur horaire et liste exhaustive des avertissements rouges. Usage du formateur commun corrigé, huitième avertissement ajouté à l'attente à sa priorité prévue ; 6 et 8 tests ciblés verts, lint des fichiers modifiés et typage verts, correction relue et approuvée. Dernier bundle **55/55, 342 924 normalisés, 342 871 bruts, marge 15 476**. Aucun seuil modifié, aucune relance du même code pour masquer l'échec.

1. Cas réel de la séance 0.3.0 : provoquer ou retrouver un iPhone dont l'ancienne époque (`s-00000001.cts`) n'a pas pu être supprimée ; ouvrir Réglages > Synchronisation > Détails : l'avertissement rouge nomme la cause traduite, l'heure du dernier essai et le dossier `devices` à vérifier ; le bandeau est visible sur les écrans principaux.
2. Vérifier dans l'app Fichiers que le chemin indiqué est bien celui du fichier resté ; le supprimer à la main : « Réessayer maintenant » ou le cycle suivant fait disparaître l'avertissement et l'iPhone publie (« Cet appareil n'a pas encore publié son état » disparaît).
3. Redémarrer l'app avec l'échec présent : l'avertissement est affiché dès le démarrage.
4. Consigner dans la checklist de l'ordre 5.
