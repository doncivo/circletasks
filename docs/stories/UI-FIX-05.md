# UI-FIX-05 — Objectif : un seul moyen d'ajouter (défaut 15)

Module : M17 Objectif de la semaine · Palier : après la 1.0 par la règle de tri (défaut visible), avancé par Ali dans l'ordre du 27 octobre 2026 après UI-FIX-04 · Agent : spaces-goals · Ouverte le 2026-10-27 par Claude Code.

Statut : **ouverte, preuve rouge écrite, aucun code**. Estimation : 1 h active ; alerte à 1 h 30.

## Demande d'Ali (liste du 27 octobre 2026, défaut 15)

« Objectif, un seul moyen d'ajouter quand le champ de saisie est déjà présent. » Piste lue par Codex : masquer le bouton d'ajout tant qu'un brouillon est ouvert, conserver l'ajout après création d'un objectif. Préserver saisie, focus et persistance. Règle 2 des maquettes de refonte : « Une décision, une commande. Deux façons de faire la même chose à l'écran : l'une des deux est du bruit. »

## Constat (code de `main`)

`GoalsScreen` affiche « + Ajouter un objectif » sous la dernière section, **y compris sous un brouillon** (champ de saisie vide, créé par ce même bouton ou implicite quand aucun objectif n'existe). Le bouton y est inerte (un seul brouillon à la fois) : deux commandes visibles pour une décision, dont une qui ne fait rien.

## Critères

1. Tant qu'un brouillon est affiché (implicite sans objectif, ou ouvert par le bouton), le bouton « + Ajouter un objectif » n'est pas rendu.
2. Dès que le brouillon devient un objectif (titre validé), le bouton revient sous le dernier objectif, une seule fois.
3. Un brouillon laissé vide ne crée rien ; sa saisie en cours et son focus sont conservés ; aucune écriture tant que le titre n'est pas validé (inchangé).
4. PC et iPhone identiques ; aucun texte, aucune route, aucune persistance modifiés.

## Preuves

- **Rouge** (commit avant tout code) : `src/features/goals/GoalsAddOnce.test.tsx` : sans objectif, champ vide sans bouton ; avec un objectif, le bouton ouvre un brouillon et disparaît, revient après création ; brouillon laissé vide conservé.
- **Vert** : à consigner.

## Passes

- Product-owner : critères ci-dessus.
- Agent du module, QA, code-reviewer : à consigner.
