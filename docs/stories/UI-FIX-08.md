# UI-FIX-08 — Événements iPhone : « Masquer les fériés » est mémorisé (PRD-02, lot F, réserve d'Ali)

Module : M7 Événements, avec M12 Réglages (réglage local) · Palier : alignement PRD-02 décidé par Ali le 2026-10-28, à livrer dans l'IPA N+1 · Agent : checklists-events · Ouverte le 2026-10-28 par Claude Code.

Statut : **fusionnée (#113, 8ed535ac), quatre passes consignées.** Estimation : 1 h 30 active ; alerte à 2 h 30.

## Origine

UI-REFONTE-07 (Evenements-v2.html) a ajouté la pastille « Masquer les fériés » comme état de l'écran, oublié à la prochaine ouverture (écart consigné, soumis dans PRD-02, lot F). Décision d'Ali : « « Masquer les fériés » doit être mémorisé. Un filtre d'affichage qui s'oublie à chaque ouverture ne sert à rien. Choisir quels pays suivre et choisir de les masquer à l'écran sont deux réglages différents, il n'y a pas de doublon. »

## Critères

1. Nouveau réglage **local** `events.hideHolidays` (booléen, faux par défaut, `scope: 'local'` : un choix d'affichage propre à l'appareil, jamais synchronisé), déclaré dans `src/domain/model/settings.ts`, écrit par `settingsUseCases.setHideHolidays` (seul point d'écriture des réglages pour les stores).
2. L'écran Événements lit ce réglage au chargement (`eventsStore`) et la pastille le bascule : masqué → fériés absents et mois vides retirés (critère 3 de UI-REFONTE-07 inchangé) ; quitter l'écran et y revenir, ou relancer l'app → même état, même libellé (« Afficher les fériés », `aria-pressed="true"`).
3. Échec d'écriture : l'affichage revient à la valeur enregistrée et l'erreur est dite (`events.saveError`), jamais muette ; optimisme et retour en arrière comme la vue compacte (A-06).
4. Les calendriers de fériés (E-03, Réglages) ne changent pas : la pastille n'existe que s'il en reste au moins un ; PC inchangé (pas de pastille).
5. Bundle de départ : la définition du réglage entre dans le départ (`settings.ts`, quelques octets mesurés) ; l'écran et son catalogue restent à la demande ; aucun module nouveau.
6. Fiche UI-REFONTE-07 : la ligne « Masquer les fériés » du tableau des écarts renvoie à cette décision.

## Preuves attendues

- **Rouge d'abord** : `src/features/events/EventsRefonte.test.tsx`, test « mémorisé » (bascule, démontage, nouveau rendu → toujours masqué ; réglage lu en base) ; test d'échec d'écriture.
- **Vert ensuite** : suites `events`, `settings` (définitions), `domain/model` ; e2e `UI-REFONTE-07` inchangé ; lint ; typage ; garde du bundle ; CI complète.

## Hors périmètre

Le PC ; les calendriers de fériés et leurs réglages ; les bandeaux d'Aujourd'hui et de la Semaine (ils gardent leurs fériés) ; le PRD.

## Passe agent du module

- **Preuve rouge** : commit 26afcf76 (tests seuls) : `src/features/events/EventsRefonte.test.tsx`, deux tests (réglage mémorisé après démontage et nouveau rendu ; échec d'écriture avec retour en arrière et message), rouges sur `main` (réglage inconnu).
- **Vert ensuite** : commit 023cee38. `src/domain/model/settings.ts` : `events.hideHolidays` (booléen, local, faux par défaut) ; `settingsUseCases.setHideHolidays` (seul point d'écriture) ; `eventsStore` : `hideHolidays` lu à chaque chargement, `setHideHolidays` optimiste avec retour à la valeur précédente et `settingErrorKey` (`events.holidaySettings.saveError`, texte existant) ; `EventsScreen` : l'état vient du store, l'erreur est dite par un `role="alert"`.
- **Fiche UI-REFONTE-07** : la ligne « Masquer les fériés » du tableau des écarts renvoie à cette décision.
- **Local** : suites `events`, `settings`, `domain/model` (344 tests) vertes ; lint ; typage.

## Mesure du bundle

Avant push (commit 023cee38, build `--manifest`, `node tests/bundle/measureStart.ts`) : **337 931 octets normalisés** (écart normalisé / brut +142, dans la borne large de 300), **marge 20 469** ; **+36** face à `main` 337 895 (définition du réglage et cas d'usage dans le départ) ; garde 66/66, aucun module nouveau. Mesure de `main` après fusion (#113, 8ed535ac) : **338 017 octets normalisés** (brute 337 990), marge 20 383, lue dans le job « Performance et bundle » de la CI sur l'arbre de `main` après #112 et #113 (aucune mesure locale : mémoire du PC). +61 face à 337 956 (#110) pour #112 (+6) et #113 (+36) et le bruit de hachage.

## Passe QA

- **CI** : trois passages, tous verts (48 contrôles) ; les deux premiers sur des têtes en retard sur `main` après les fusions voisines (#109, #110, #112), mises à jour sans modification de code. Fusionnée (#113, 8ed535ac). Aucune adaptation de test après coup.

## Passe code-reviewer

Relecture à froid du diff. Vérifié : réglage **local** (jamais synchronisé : un choix d'affichage propre à l'appareil, sans effet sur les calendriers de fériés de Réglages, E-03) ; lecture tolérante (une base illisible donne « faux », jamais un écran bloqué) ; la bascule est optimiste et revient à la valeur enregistrée en cas d'échec, avec un message visible (aucun échec muet) ; le PC n'a pas la pastille, donc rien ne change ; l'e2e `UI-REFONTE-07` bascule et rebascule dans le même test, sans dépendre de l'ordre. Point laissé à la QA : un réglage resté à « masqué » alors que plus aucun calendrier de fériés n'est activé ne cache rien et la pastille n'apparaît pas (pas de commande qui ne peut rien faire).

Verdict : approuvée sous réserve de la CI complète (QA à consigner).
