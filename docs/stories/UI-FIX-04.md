# UI-FIX-04 — Retour iPhone à gauche partout (défaut 12)

Module : transverse (M2, M12, M13, M15, M17, M18) · Palier : après la 1.0 par la règle de tri (défaut visible), avancé par Ali dans l'ordre du 27 octobre 2026 après N-FIX-04 · Agent : ui-design-system · Ouverte le 2026-10-27 par Claude Code.

Statut : **ouverte, preuves rouges écrites, aucun code**. Estimation : 1 h 30 actives ; alerte à 2 h 15.

## Demande d'Ali (liste du 27 octobre 2026, défaut 12)

« Retour iOS à gauche partout. » Le Rapport du mois est fait par UI-FIX-03 (#88) : retour à gauche, flèche `ArrowLeft`. Reste l'écran Objectif, puis vérifier les autres retours.

## Constat (code de `main` après #91)

Treize écrans iPhone portent un bouton « Retour ». Douze le placent **en haut à droite** (`justify-content: flex-end` sur la rangée) avec l'icône « annuler » (`Undo2`) : Objectif, Un jour, Terminées, Corbeille, Espaces, Plages silencieuses, Synchronisation › Détails (icône seulement, rangée déjà au début), Récapitulatifs, Apparence, Import, Calendriers, Jours fériés. Seul le Rapport est conforme.

## Critères

1. Sur chacun de ces écrans, le bouton « Retour » garde son libellé, sa destination et sa taille ; il porte la flèche `ArrowLeft` ; sa rangée est alignée au début (`flex-start`), jamais `flex-end`.
2. Le PC ne change pas : ces rangées n'existent que dans la mise en page mobile.
3. Aucun texte, aucune route, aucun test de navigation existant modifié dans son sens.

## Preuves

- **Rouge** (commit avant tout code) : `src/features/app/backButtonsLeft.test.ts`, contrat statique sur les treize écrans (icône et alignement) ; `tests/e2e/UI-FIX-04.spec.ts`, géométrie sur Objectif et Un jour en projet `iphone` (même oracle que UI-FIX-03).
- **Vert** : à consigner.

## Passes

- Product-owner : liste des treize écrans et critères ci-dessus ; le Rapport sert de référence.
- Agent du module, QA, code-reviewer : à consigner.
