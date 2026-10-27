# UI-FIX-05 — Objectif : un seul moyen d'ajouter (défaut 15)

Module : M17 Objectif de la semaine · Palier : après la 1.0 par la règle de tri (défaut visible), avancé par Ali dans l'ordre du 27 octobre 2026 après UI-FIX-04 · Agent : spaces-goals · Ouverte le 2026-10-27 par Claude Code.

Statut : **fait** — PR #94 fusionnée le 2026-10-27 (runs 40550343167 relancé après annulation WebKit et 40550351616, 48 contrôles verts), `main` 89a1f9c6, bundle de `main` mesuré à 335 256 normalisés, marge 23 144 ; observation sur l'iPhone au prochain lot. Estimation : 1 h active ; alerte à 1 h 30.

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
- **Vert** (commit du correctif, identifiant au journal) : suites Objectif **123 tests / 10 fichiers verts** (dont le test historique du critère 6, inchangé : après création, un seul bouton) ; lint, typage ; e2e OB-01 à OB-06 sur `pc` et `iphone` **52 verts, 2 ignorés volontaires** ; garde du bundle **62/62, 335 256 normalisés, marge 23 144**, inchangé face à UI-FIX-04.

## Passes

- **Product-owner** : critères ci-dessus ; piste de Codex retenue telle quelle.
- **Agent du module** : `GoalsScreen.tsx` seulement : le bouton n'est rendu sous le dernier objectif que sans brouillon affiché ; les brouillons ne portent plus d'action. `GoalDraft` garde sa propriété `actions` (inutilisée ici) pour ne pas changer son contrat.
- **QA** : preuve rouge `88d4c1b2` (trois échecs : bouton présent sous le brouillon, et sous le champ implicite sans objectif), puis vert ; suites Objectif rejouées ; e2e OB-01 à OB-06 sur `pc` et `iphone`.
- **Code-reviewer** (relecture à froid du diff) : approuvée. Une condition et une propriété retirée ; aucune écriture, aucune route, aucun texte touchés ; la création, le focus et la conservation du brouillon sont inchangés et couverts par les tests.
