# UI-FIX-08 — Événements iPhone : « Masquer les fériés » est mémorisé (PRD-02, lot F, réserve d'Ali)

Module : M7 Événements, avec M12 Réglages (réglage local) · Palier : alignement PRD-02 décidé par Ali le 2026-10-28, à livrer dans l'IPA N+1 · Agent : checklists-events · Ouverte le 2026-10-28 par Claude Code.

Statut : **ouverte, passe product-owner écrite.** Estimation : 1 h 30 active ; alerte à 2 h 30.

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

À écrire après la preuve rouge.

## Passe QA

À écrire après la CI complète.

## Passe code-reviewer

À écrire.
