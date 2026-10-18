# N-FIX-02 — Corps de notification avec heure, espace et date : un constructeur unique testé sur le texte final

Module : M5 Rappels · Ordre de construction : palier 1.0, **étape 6 (B10), après N-TECH-02** (même dossier `src/features/reminders` et même budget de départ : jamais en parallèle) · Agent : **notifications** · Relecture : code-reviewer (après qa-test) · Estimation : **3 h** (audit B10), **alerte à Ali au-delà de 4,5 h (+50 %)** · Statut : fiche écrite, à développer
Correctif sans équivalent au PRD (écart à noter dans docs/decisions.md : ligne du 2026-10-18). Source : docs/audit-1.0.md, ligne B10. Règles de CLAUDE.md : les rappels sont émis sur l'iPhone uniquement ; textes dans `src/i18n`, heures en 24 h ; règles métier dans `src/domain`.
Dépend de : N-01, N-03, N-TECH-02 (pour la marge de bundle, voir ci-dessous). Touche `src/features/reminders/notificationTexts.ts`, `replanNotifications.ts` (contenu du dictionnaire de recherche seulement), `src/i18n/fr.notifications.ts` et `en.notifications.ts`, un nouveau module de `src/domain`, et trois fichiers de tests existants. Ne touche ni le planificateur, ni `src/db`, ni Swift, ni Rust.

## Contexte

Constat (lignes vérifiées sur `main` c01e961b) :
- Le fichier est `src/features/reminders/notificationTexts.ts` (68 lignes), pas `src/features/notifications/` (dossier inexistant) ; les lignes 187-221 citées par l'audit n'existent plus. Les lignes concernées sont **22-25** (`reminderBody` : « À l'heure » si l'avance est 0, sinon « Dans {advance} » par `advanceLabel`, lignes 17-20) et **43-56** (`requestFor` : les quatre natures `task`, `routine`, `event`, `snooze` appellent `reminderBody(item.offsetMin)` aux lignes 47, 49, 51 et 55). Textes : `src/i18n/fr.notifications.ts` lignes 7-10 (`body.atTime`, `body.inAdvance`) et 11-14 (`advance.week`).
- Conséquences : (1) aucun corps ne contient l'heure ni l'espace ; (2) un rappel décalé par une plage silencieuse (Pro, 19:00 → 08:00 et week-end) sonne le lendemain à 08:00 en disant « À l'heure » ; (3) la répétition « +15 min » reprend `reminderBody(item.offsetMin)` de l'origine et dit « Dans 30 min » quinze minutes plus tard ; (4) un événement « journée entière » (rappel conventionnel à 09:00, `EVENT_ALL_DAY_REMINDER_TIME`) dit « À l'heure » ; (5) un événement ou une tâche annoncés la veille ne disent pas pour quel jour. Même après le correctif des aperçus masqués (N-IOS-FIX-01, voir « Cohérence »), l'écran verrouillé n'affichera pas l'heure tant que le corps ne la porte pas.
- Pourquoi les tests ne l'attrapaient pas : `src/features/reminders/replanNotifications.test.ts` lignes 43-44 comparent à des chaînes qui sont celles du catalogue (« Dans 30 min », « À l’heure ») ; personne n'évalue le texte lu par l'utilisateur. Les mêmes chaînes figurent dans `tests/e2e/N-01.spec.ts:46` et `tests/e2e/N-03.spec.ts:72` (le corps d'une répétition « +15 min » y est attendu « À l’heure »). `src/platform/notifications/tauriNotifications.test.ts:36,242` passe un corps arbitraire à l'adaptateur : sans rapport, inchangé.
- Le correctif précédent des aperçus : **N-IOS-FIX-01** (docs/backlog.md ligne 184, décision du 2026-10-16 dans docs/decisions.md) est un texte de remplacement posé sur les catégories de notification pour le cas où iOS masque le contenu (Réglages iOS > Notifications > Afficher les aperçus = « Si déverrouillé »). Sa fiche n'existe pas dans ce worktree (statut « à faire » au backlog). Il ne change pas le corps des notifications.

## Décisions retenues

1. **Un seul constructeur** : `notificationBody(item, lookup)` dans `notificationTexts.ts` produit le corps des quatre natures de rappel (tâche, routine, événement, répétition). Il compose du texte à partir d'une **description structurée pure** calculée dans `src/domain/notificationBody.ts` (`bodyParts(item, context)` : jour à afficher ou non, heure d'échéance ou « journée entière », échéance d'origine si décalé ; aucun texte, aucun import de `src/i18n`). `reminderBody`, `advanceLabel` et les textes `body.atTime`, `body.inAdvance`, `advance.week` sont **supprimés** (plus aucun usage ; les cases d'avance de l'interface utilisent `reminders.choice*`, inchangés).
2. **Heure affichée = heure d'échéance de l'élément, jamais l'heure de sonnerie.** Pour tâche, routine et événement : échéance d'origine (`scheduledAt`) plus l'avance (`offsetMin`) en arithmétique de dates civiles flottantes, c'est-à-dire l'heure de la tâche, de la routine ou du début de l'événement. L'avance n'est plus écrite : « 09:00 » lu à 08:30 se comprend, et la date lève toute ambiguïté (règle 3). Pour une répétition « +15 min » : heure de la cible lue dans le dictionnaire de recherche (`lookup`).
3. **Règle du jour** : le corps commence par le jour (`mer. 23 sept.`, format `formatDayLabel`) quand l'élément est un **événement** (toujours) ou quand le jour de l'occurrence diffère du jour de l'échéance effective de sonnerie (annonce la veille, décalage par plage silencieuse). Sinon, l'heure seule.
4. **Espace** : le nom de l'espace de l'élément (`Pro`, `Perso`, tel que stocké). Espace introuvable : le corps se passe de l'espace, sans séparateur orphelin.
5. **Décalage** : `(prévu 19:30)` à la fin, quand l'échéance effective diffère de l'échéance d'origine. L'heure est celle de l'échéance d'origine (heure de sonnerie prévue, donc avance comprise). Si le jour de l'échéance d'origine est le jour de l'occurrence : heure seule. Sinon (annonce la veille puis décalage) : « le 26 sept. à 09:00 » (texte `detail.stampOn` existant). Jamais pour les récapitulatifs, la fin de Focus, ni la répétition.
6. **Journée entière** : le libellé « Journée entière » (`events.allDay`, existant) remplace l'heure ; **aucune** heure n'est affichée pour un événement de journée entière (le 09:00 est une convention de rappel, pas une heure d'événement). Le décalage « (prévu 09:00) » reste permis : c'est l'heure prévue de sonnerie.
7. **Répétition « +15 min »** : `Reporté · 14:00`, forme exacte demandée par Ali (heure de l'élément reporté, sans espace). Jour devant l'heure par la même règle 3 (jour de l'occurrence différent du jour de sonnerie de la répétition, ou événement). Question 1 à Ali : ajouter l'espace ?
8. **Textes** (français, source de vérité ; `en.notifications.ts` suit) : `notifications.body.line` = « {when} · {space} », `notifications.body.dayTime` = « {day} · {time} », `notifications.body.shifted` = « {line} (prévu {from}) », `notifications.body.snoozed` = « Reporté · {when} ». Réutilisés : `events.allDay`, `detail.stampOn`. Heures par `formatTime` de `src/i18n/format` (24 h par défaut ; suit le choix P-03 s'il est fait). **Aucun pluriel automatique** : aucun nombre n'entre dans ces textes.
9. **Récapitulatifs et fin de session Focus : inchangés.**

## Bundle de départ (plafond inamovible)

- Référence : **358 357 / 358 400 octets gzip** (`tests/bundle/startBundle.test.ts`, qui ne somme que les fichiers `.js` du graphe statique de `index.html`), marge **43 octets** ; l'audit du départ estime cette story à +100 à +300 octets.
- `notificationTexts.ts` est dans le départ aujourd'hui (imports statiques `App.tsx:17` → `startup.ts:11` → `notificationRunner.ts:2` → `replanNotifications.ts:12` → `notificationTexts.ts`). `src/i18n/fr.notifications.ts` est inclus dans `fr.ts` : **les nouvelles chaînes françaises restent dans le départ** même si le code devient paresseux (le catalogue anglais, lui, est déjà à la demande).
- **Condition d'entrée** : N-TECH-02 doit être fusionnée (ou la branche de N-FIX-02 construite dessus) **avec son levier** (`notificationRunner.ts` charge `replanNotifications`, donc `notificationTexts.ts` et le nouveau `notificationBody.ts`, par `import()`). Alors le code de cette story est hors du départ et seul le catalogue compte : 4 chaînes ajoutées (environ 67 caractères) contre 3 retirées (`atTime`, `inAdvance`, `week`, environ 32 caractères et leurs clés), soit un net attendu de **+20 à +30 octets gzip**, à mesurer ; si ce net dépasse la marge restante, retirer d'abord du catalogue de notifications toute chaîne devenue inutile.
- **Exigence : net <= 0 octet** par commit et pour la branche dès que la marge de N-TECH-02 le permet ; **mesure après chaque commit** (`npm run test:bundle`), valeur notée dans « Preuves ». Si le levier de N-TECH-02 n'a pas été livré, ou si le net reste > 0 : **arrêt et remontée à Ali** (paliers BUNDLE-01, docs/audits/2026-10-18-bundle-depart.md) ; aucun plafond relevé.

## Critères testables

Locale `fr`, format d'heure 24 h, date de référence mer. **2026-09-23** (comme les maquettes), espaces `Pro` (plages par défaut 19:00 → 08:00 et samedi-dimanche entiers) et `Perso` (aucune plage). Les corps sont comparés à des **chaînes littérales** (jamais à `t(...)`). Chaque ligne est **rouge avant** sur `main` c01e961b.

### Tableau de cas exacts (constructeur testé sur le texte final)

Test : `src/features/reminders/notificationBody.test.ts`, qui passe par `requestFor(item, lookup).body` (API existante, donc rouge par assertion et non par erreur de compilation ; le dictionnaire de recherche est un objet de la forme étendue).

1. **Tâche Pro 09:00, avance 0**, sonne mer. 23 sept. 09:00 : `09:00 · Pro`.
2. **Tâche Perso 09:00, avance 30** (sonne 08:30) : `09:00 · Perso` ; avance 15, 60 : idem.
3. **Tâche Perso jeu. 24 sept. 09:00, avance 1440** (sonne mer. 23 09:00) : `jeu. 24 sept. · 09:00 · Perso`.
4. **Tâche Pro mar. 22 sept. 20:00, avance 30**, plages Pro (sonne mer. 23 sept. 08:00, prévu mar. 19:30) : `mar. 22 sept. · 20:00 · Pro (prévu 19:30)`.
5. **Même tâche, avance 0** (prévu 20:00) : `mar. 22 sept. · 20:00 · Pro (prévu 20:00)`.
6. **Tâche Pro mer. 23 sept. 07:00, avance 0** (dans la plage du mardi soir, sonne mer. 08:00, même jour) : `07:00 · Pro (prévu 07:00)`.
7. **Tâche Pro ven. 25 sept. 19:30, avance 0** (enchaînement jusqu'au lun. 28 sept. 08:00) : `ven. 25 sept. · 19:30 · Pro (prévu 19:30)`.
8. **Tâche Pro dim. 27 sept. 09:00, avance 1440** (prévu sam. 26 à 09:00, dans la plage du week-end, sonne lun. 28 à 08:00) : `dim. 27 sept. · 09:00 · Pro (prévu le 26 sept. à 09:00)`.
9. **Routine Perso 07:00, avance 0** : `07:00 · Perso`. **Routine Pro 20:00 mar. 22 sept., avance 0**, décalée au lendemain 08:00 : `mar. 22 sept. · 20:00 · Pro (prévu 20:00)`.
10. **Événement « Réunion » Pro mer. 23 sept. 14:30** : avance 0, 1440 et 10080 : `mer. 23 sept. · 14:30 · Pro` dans les trois cas.
11. **Événement journée entière Perso ven. 12 mars 2027**, avance 1440 (sonne jeu. 11 mars 09:00) : `ven. 12 mars · Journée entière · Perso` ; avance 0 : même texte. Le corps ne contient ni « 09:00 » ni « À l'heure ».
12. **Événement journée entière Pro sam. 26 sept., avance 0**, décalé par le week-end au lun. 28 sept. 08:00 : `sam. 26 sept. · Journée entière · Pro (prévu 09:00)`.
13. **Répétition « +15 min »** : tâche Perso 14:00 du jour, sonne 14:15 : `Reporté · 14:00` ; tâche du jeu. 24 sept. 09:00 annoncée la veille, répétition le mer. 23 à 09:15 : `Reporté · jeu. 24 sept. · 09:00` ; routine 07:00 : `Reporté · 07:00` ; événement 14:30 du jour : `Reporté · mer. 23 sept. · 14:30` ; événement journée entière du ven. 12 mars 2027 : `Reporté · ven. 12 mars · Journée entière`. Jamais « Dans 30 min ».
14. **Espace introuvable** dans le dictionnaire : tâche 09:00 : `09:00` ; événement 14:30 : `mer. 23 sept. · 14:30` ; avec décalage : `… (prévu 19:30)` sans séparateur ni espace orphelin.
15. **Format 12 h** (réglage P-03) : tâche Pro 09:00 : `9:00 AM · Pro` (preuve que l'heure passe par l'unique point d'affichage `formatTime`).
16. **Récapitulatifs et fin de Focus inchangés** : mêmes chaînes qu'avant (matin avec lignes « 09:00 Titre » et « et 2 autres », texte générique « Ouvrez CircleTasks pour voir votre journée »), assertion par littéraux.

### Structure, constructeur unique, textes

17. **Description pure** (`src/domain/notificationBody.test.ts`) : pour chaque ligne 1 à 14, `bodyParts` rend la structure attendue (jour affiché ou non, heure ou journée entière, origine du décalage avec son jour) ; la fonction n'importe ni `src/i18n`, ni `src/platform`, ni `src/db`, n'appelle ni `Date.now` ni `Math.random`, ne modifie pas ses arguments.
18. **Constructeur unique** : `notificationTexts.ts` n'exporte plus `reminderBody` ni `advanceLabel` ; `body.atTime`, `body.inAdvance` et `advance.week` n'existent plus dans `fr.notifications.ts` ni `en.notifications.ts` ; un test (espion) vérifie que `requestFor` passe par `notificationBody` pour chacune des quatre natures et pour aucune autre ; aucun autre module de `src` ne compose un corps de rappel (recherche de `body:` dans les modules qui construisent des `NotificationRequest` de rappel).
19. **Aucun texte brut ni clé affichée** : sur toutes les lignes du tableau, le corps ne contient ni `{`, ni `}`, ni `notifications.` ; catalogues fr et en ont les mêmes clés (test de parité existant) ; un cas anglais minimal est non vide.
20. **Aucun pluriel automatique, aucun nombre** : les quatre textes ne contiennent aucun paramètre numérique ni forme plurielle.

### Intégration et non-régression

21. **De bout en bout du cas d'usage** : `replanNotifications.test.ts` lignes 43-44 passent de « Dans 30 min » / « À l’heure » à `09:00 · {espace}` (les deux requêtes de la tâche « Appeler le médecin » : avances 30 et 0), `tests/e2e/N-01.spec.ts:46` et `tests/e2e/N-03.spec.ts:72` reçoivent leurs nouvelles chaînes littérales (heure et espace du scénario ; `Reporté · {HH:MM}` pour la répétition) ; chaque modification est tracée « ancienne attente → nouvelle attente » dans « Preuves ». Aucun test supprimé, désactivé, assoupli ni allongé.
22. **Un plan réel** : un test construit un plan avec `planNotifications` (tâche Pro 20:00 avance 30 mar. 22 sept., événement journée entière, répétition) puis `requestsFor` et vérifie les trois corps littéraux des lignes 4, 11 et 13 (le décalage vient bien de `scheduledAt` ≠ `fireAt`, pas d'une saisie à la main).
23. **Journal et PC** : le journal technique ne reçoit toujours aucun corps ni titre (code et nombres seulement, comme avant) ; le PC n'émet aucune notification de rappel (`noNotification.test.ts` et `capture/consistency.test.ts` inchangés).

### Bundle, cohérence, documentation

24. **Bundle** : référence mesurée au premier commit, puis après chaque commit ; net selon « Bundle de départ ». Valeurs notées.
25. **Cohérence avec les aperçus** : si N-IOS-FIX-01 est fusionnée avant, aucune chaîne du catalogue de notifications (texte de remplacement, ligne d'aide) ne cite l'ancien format (« À l’heure », « Dans … ») : recherche textuelle dans `fr.notifications.ts` ; sinon la fiche le note et N-IOS-FIX-01 reste indépendante (ce correctif ne change ni catégories ni Swift).
26. **Documentation** : docs/decisions.md (ligne du 2026-10-18 : format des corps, écart à l'ADR 0012 avenant N1.3 qui prévoyait « À l'heure » / « Dans {avance} »), ADR 0012 (avenant : contenu du corps), docs/journal.md, docs/backlog.md, docs/audit-1.0.md (B10). Aucun écart avec le PRD (N-01 : « Notification iOS sur l'iPhone uniquement »).
27. **Vérifications** : tests du module en local seulement (`CT_TEST_WORKERS=1 npx vitest run src/features/reminders src/domain/notificationBody src/platform/notifications src/i18n --coverage.enabled=false`), lint et typage verts ; les deux e2e modifiés listés par `playwright test --list` et lancés en CI ; suite complète en CI (« suite verte »).

## Hors de cette story

- Texte de remplacement des aperçus masqués et ligne d'aide dans Réglages (N-IOS-FIX-01) ; essai des `%` sur l'iPhone (N-IOS-CHK-01).
- Fenêtre de 7 jours et plafond (N-TECH-02) ; titre des notifications ; boutons « Fait » et « +15 min » (N-03).
- Choix de l'avance dans le corps (« Dans 30 min ») : retiré volontairement (décision 2).
- Toute fonction de la liste « Hors périmètre » du PRD (section 1).

## Plan par phases

1. **Tableau rouge (0,75 h)** : critères 1 à 16 contre `requestFor` sur `main` ; noter la première assertion en échec ; commit « test seul ».
2. **Description pure (0,5 h)** : `src/domain/notificationBody.ts` et ses tests (critère 17).
3. **Constructeur, textes fr et en (1 h)** : `notificationBody`, extension du dictionnaire de recherche (espaces, durées, journée entière) dans `replanNotifications.ts`, suppression des anciennes fonctions et chaînes (critères 18 à 20) ; mesure du départ après chaque commit.
4. **Tests existants et plan réel (0,5 h)** : critères 21 à 23.
5. **Mesure, documentation, qa-test puis code-reviewer (0,25 h)** : critères 24 à 27.

Découpage : 0,75 + 0,5 + 1 + 0,5 + 0,25 = 3 h.

## Vérifications

- Local : tests du module (commande du critère 27) ; suite complète en CI.
- Preuve de détection : le tableau (critères 1 à 15) est rouge avant, vert après ; la mutation « corps = reminderBody ancien » fait échouer au moins 15 lignes.
- Règle d'Ali : arrêt et alerte avant de continuer si l'estimation dérape de plus de 50 % (au-delà de 4,5 h) ou si le net de bundle dépasse la marge.
- Aucun fichier écrit hors du dépôt ; aucun secret.
- Clôture refusée si un critère manque : le product-owner vérifie les 27 critères avant « fait ».

## Preuves (à remplir par l'agent)

| Élément | Valeur |
|---|---|
| Départ de référence (octets gzip, seuil 358 400) | |
| Tableau (critères 1 à 16), rouge avant (commit, première assertion en échec) | |
| Tableau, vert après (commit) | |
| Départ après chaque commit | |
| Tableau « ancienne attente → nouvelle attente » (critère 21) | |
| Commandes locales et résultats | |

## Écarts

(aucun à ce jour)

## Questions à Ali (sans bloquer)

1. **Répétition « +15 min » : ajouter l'espace** (`Reporté · 14:00 · Pro`) ? Recommandation : **non**, rester sur la forme demandée (`Reporté · 14:00`) ; le titre suffit à situer une répétition qu'Ali vient de demander.
2. **« (prévu 20:00) » quand l'avance est 0** : le texte répète l'heure d'échéance (`20:00 · Pro (prévu 20:00)`). Recommandation : le garder, c'est la règle uniforme qui dit « ce rappel est en retard sur son heure prévue » ; une exception pour l'avance 0 ajouterait un cas et une chaîne.
3. **Date dans le corps des tâches annoncées la veille** (`jeu. 24 sept. · 09:00 · Perso`) : ajout non demandé explicitement mais nécessaire (« 09:00 » lu la veille serait faux). Recommandation : le garder.
4. **Dépendance au bundle** : cette story n'entre dans la marge que si le levier de N-TECH-02 est livré ; sinon décision BUNDLE-01 d'Ali (voir « Bundle de départ »).
