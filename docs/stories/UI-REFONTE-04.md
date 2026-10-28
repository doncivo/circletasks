# UI-REFONTE-04 — Synchronisation : l'état en une phrase vraie, appareils sur un gabarit, conflits nommés, « Repartir de zéro » isolé

Module : M15 Synchronisation · Palier : refontes après la 1.0.2, troisième des huit dans l'ordre d'Ali du 2026-10-27 · Agent : sync-icloud avec ui-design-system · Ouverte le 2026-10-28 par Claude Code.

Statut : **ouverte, passe product-owner écrite.** Estimation : 6 à 9 h actives ; alerte à 12 h.

Références : `docs/maquettes-refonte/Synchro-v4.html`, huit règles transversales du README du même dossier. Écran de départ : `src/features/sync/SyncDetailsScreen.tsx` (hôte à la demande `lazyScreens.tsx`), `SyncStatusLine.tsx`, `SyncNowButton.tsx`, `SyncDeviceName.tsx`, `ConflictList.tsx` + `conflictText.ts`, `SyncDetailsReset.tsx`, `SyncDetailsScreen.css`, `ConflictList.css` ; textes `src/i18n/fr.syncEngine.ts`, `fr.syncConflicts.ts`, `fr.syncReset.ts` (et leurs `en.`). Un seul écran pour PC et iPhone (aucune maquette PC : la colonne de Réglages reste la même ; les règles 1 à 8 valent pour les deux).

## Passe product-owner

### Ce que la maquette change (et ce qu'elle ne change pas)

L'écran garde tout ce qu'il sait faire : état et « Synchroniser » (Y-02, Y-03), appareils nommés, renommés, oubliés (Y-10), appairage (Y-06, Y-IOS-02), version (Y-07), avertissements et secours (Y-TECH-02, Y-FIX-02), compte rendu d'époque (Y-TECH-05), fichiers en attente, journal des conflits et restauration (Y-04), réinitialisation (Y-11), suppression de ses propres fichiers (Y-IOS-02-FIX-01). Ce qui change : la hiérarchie et les formulations. L'**état devient une carte** en une phrase (la ligne d'état actuelle, inchangée mot pour mot), bordée de vert seulement quand tout est effectivement parti (`syncStatusTone === 'success'`, règle 5), le dossier en sous-ligne, « Synchroniser » à droite ; le titre « ÉTAT » disparaît. Les **titres de section passent en bas de casse** (« Appareils », « Conflits de cette semaine », « Repartir de zéro » en rouge), en 17 px encre, au lieu des petites capitales espacées. Les **appareils** partagent un gabarit : nom, sous-ligne de lecture, statut en pastille alignée à droite ; l'identifiant interne disparaît (règle 4) ; l'aide « Touchez un nom pour le modifier » passe sous la liste. Les **conflits** nomment ce qui a changé (« Heure prévue de « Envoyer la facture » ») au lieu de « titre · champ » ; la valeur appliquée en gras avec « Appliquée · iPhone, 18:04 », la valeur écartée en retrait avec « Rétablir » ; les mots « gardée » et « écartée » quittent l'affichage (ils restent dans les libellés accessibles). **« Repartir de zéro »** : titre rouge, bloc qui annonce son coût en une phrase, bouton rouge au trait pleine largeur « Réinitialiser la synchronisation » (règle 6), au bas de l'écran comme aujourd'hui.

### Écarts avec la maquette et le PRD, assumés

| Source | Formulation | Choix de la story |
| --- | --- | --- |
| Maquette | bouton « Vérifier », état « Tout est parti vers iCloud », « Dernier envoi il y a 2 minutes » | la carte reprend **la ligne d'état existante** (« À jour · il y a 2 min », « Synchro incomplète : voir les avertissements », erreurs nommées…) et le bouton **« Synchroniser »** (PRD Y-03, bannière A-09, aides e2e) : une seule formulation de l'état dans toute l'app ; « Vérifier » laisserait croire à une lecture seule |
| Maquette | appareils « Actif / Actif / Oublié » seulement | les huit statuts existants restent (« Horloge en avance », « Version plus récente : mettez à jour l'app »…), en pastille : vert pour actif, gris pour oublié ou jamais vu, rouge pour le reste |
| Maquette | conflits « Appliquée · iPhone, 00:11 » | même forme ; les heures gardent le format existant (« 18:04 », « hier à 03:21 », « le 2 oct. à 03:21 ») |
| PRD Y-04 | « Journal : élément, champ, valeur gardée, valeur écartée, appareil, date » | tout y est, autrement dit : « Heure prévue de « Envoyer la facture » », valeur appliquée, valeur écartée ; « Restaurer » devient **« Rétablir »** (bouton, libellé accessible, message « Valeur rétablie », « Rétablie le 22 sept. ») |
| PRD Y-11 (fiche) | « RÉINITIALISATION » | titre « Repartir de zéro » ; le dialogue de confirmation `ResetSyncDialog` et la confirmation native ne changent pas |

À ajouter à la ligne PRD-02 proposée par UI-REFONTE-02 : Y-04 (verbe « Rétablir », nommage du conflit).

### Critères

1. **Retour et titre.** En haut, un bouton texte « Réglages » précédé de la flèche (`ArrowLeft`), libellé accessible « Retour à Réglages » conservé ; titre « Synchronisation » (Fraunces, 36 px sur iPhone, inchangé sur PC).
2. **Carte d'état** `.ct-sync__stateCard[data-tone]` : rond coloré, ligne d'état (texte actuel de `statusLine`, `data-testid="sync-status-text"` et classe `.ct-sync__sub` conservés), dossier en sous-ligne (« iCloud Drive / CircleTasks »), « Synchroniser » à droite (absent quand il n'a rien à faire : non configurée, à associer). Bordure et rond verts **seulement** pour `syncStatusTone === 'success'` ; rouge pour `danger` ; gris pour `neutral` (en cours, en attente, fichiers en attente, avertissements). Plus de titre « ÉTAT ». Ligne de progression, identifiant de clé, « Choisir le dossier », suppression de ses fichiers, appairage, version : inchangés, sous la carte.
3. **Titres de section** : « Appareils », « Avertissements », « En attente d’iCloud », « Conflits de cette semaine », « Repartir de zéro » (rouge, `data-tone="danger"`), « Appareils à associer de nouveau », « Nouvelle clé de secours », « Oubli d’un appareil », « Version » ; aucun titre en capitales dans `.ct-sync` ; même ordre qu'aujourd'hui.
4. **Appareils** : chaque ligne : nom (bouton de renommage conservé), sous-ligne « Cet appareil · lu il y a 2 min » / « Dernière modification lue : … » / « Jamais lu » (textes existants), pastille de statut `.ct-sync__deviceState[data-tone]` (vert `success` pour « Actif », gris `muted` pour « Oublié » et « Jamais vu », rouge `danger` pour les autres) ; « Oublier cet appareil » et le reste des actions inchangés ; **plus d'identifiant complet** : cet appareil n'en montre aucun, les autres gardent leurs **8 premiers caractères** (audit Y-10, ADR 0011 §18 point 8 : ce sont ceux que la boîte native « Oublier cet appareil » affiche, l'utilisateur doit pouvoir les rapprocher ; l'exigence de l'audit l'emporte sur la règle 4) ; attribut `data-device-id` sur la ligne pour les tests ; aide « Touchez un nom pour le modifier… » sous la liste ; listes vides et états « à associer » inchangés.
5. **Conflits** : titre « Conflits de cette semaine », phrase d'aide « Deux appareils ont modifié la même chose. La version la plus récente est appliquée. », puis la ligne de compte existante (« 2 conflits cette semaine » / « Aucun conflit cette semaine »), puis la liste (`role="list"` « Journal des conflits » conservé). Chaque conflit : titre « {Champ} de « {titre} » » (initiale en capitale, titre tronqué à 80 caractères, « Élément supprimé » quand l'élément n'existe plus), date de détection à droite ; ligne appliquée : valeur en gras, « Appliquée · {appareil}, {heure} » ; ligne écartée : valeur en gris, « {appareil}, {heure} », bouton « Rétablir » (libellé « Rétablir la valeur écartée : {titre}, {champ} »), « Rétablie le 22 sept. » après coup ; messages de résultat, refus, illisibles, « Afficher plus », annulation par le bandeau : inchangés (« Valeur rétablie »).
6. **Repartir de zéro** : titre rouge ; quand la réinitialisation est possible, un bloc `.ct-sync__resetCard` : « Une nouvelle clé est créée. **Vos autres appareils devront être associés de nouveau** (QR code ou clé de secours) et l’historique partagé repart à zéro. Vos tâches ne sont pas supprimées. » puis le bouton `.ct-sync__resetButton` pleine largeur, rouge au trait, « Réinitialiser la synchronisation » (libellé accessible actuel) ; la ligne « Nouvelle clé et nouvelle clé de secours… » disparaît (dite par le bloc). États en cours, échecs, appareils à associer, nouvelle clé de secours : inchangés, dans la même section.
7. **Sombre** : jetons existants (`--ct-color-achieved-*`, `--ct-color-danger*`, `--ct-color-surface-input`, `--ct-color-agenda-hour`) ; aucune paire nouvelle ou alors ajoutée à `cssContrastKit.ts`.
8. **Largeur et zone de sécurité** : aucun élément plus large que l'écran sur iPhone (aide `expectFitsViewport`), marges latérales existantes conservées.
9. **Bundle de départ** : textes nouveaux (phrase d'aide des conflits, « Appliquée », bloc « Repartir de zéro ») dans un catalogue à la demande `src/i18n/syncRefonteText.ts` chargé avec l'écran ; les valeurs modifiées de clés existantes (`fr.syncEngine`, `fr.syncConflicts`, `fr.syncReset`, et `en.`) restent dans le départ à taille égale ; aucun module nouveau dans `start-modules.json` ; mesure avant push et sur `main` après fusion.
10. **Comportements** : aucun changement de logique (phases, tons, refus, annonces `role="status"`, focus après « Rétablir ») ; les tests existants sont adaptés aux textes et à la structure, jamais à un comportement.

### Preuves attendues

- **Rouge d'abord** (commit de tests seuls) : `src/features/sync/SyncRefonte.test.tsx` (retour texte, carte et ses trois tons, titres en bas de casse, pastilles d'appareils et identifiant absent, aide sous la liste, conflit nommé et « Rétablir », bloc « Repartir de zéro ») ; e2e `tests/e2e/UI-REFONTE-04.spec.ts` sur `pc`, `iphone` et `iphone-webkit` (app de développement, synchro non configurée : retour, carte en gris, titres, largeur iPhone, thème sombre).
- **Vert ensuite** : suites `sync` (Vitest), adaptations tracées : `SyncScreens.test`, `SyncDetailsVersion.test` (« Version », « Appareils »), `ConflictList.test` (titres, « Rétablir », plus de « gardée / écartée »), `SyncDetailsReset.test` (ligne d'aide), `deviceNames.test` si l'identifiant y est lu, `carryReportReview2` et `carryWarnings` (via `t()`, sans doute inchangés) ; lint ; typage ; garde du bundle ; CI complète.

### Hors périmètre

Les cinq autres refontes ; le PRD ; la ligne « Synchronisation » de l'accueil de Réglages (`SyncSettingsSection`, refonte Réglages PC) ; la fenêtre `pairing` ; toute logique de synchronisation.

## Passe agent du module

À écrire après la preuve rouge.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

À écrire.
