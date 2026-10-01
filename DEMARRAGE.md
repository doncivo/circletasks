# Kit de démarrage CircleTasks

Ce dossier contient tout ce dont Claude Code a besoin pour développer CircleTasks. Décompressez-le à la racine du dépôt `circletasks`.

## Contenu

| Élément | Rôle |
| --- | --- |
| `CLAUDE.md` | Mémoire du projet, lue par Claude Code à chaque session |
| `.claude/agents/` | Les 26 sous-agents (PRD section 11) |
| `docs/PRD.md` | Le PRD complet, seule référence fonctionnelle |
| `docs/backlog.md` | Les 121 user stories et les tâches de préparation, de vérification et de livraison, triées par ordre de construction |
| `docs/maquettes/` | Les 34 écrans validés ; ouvrir `index.html` dans un navigateur |
| `docs/adr/`, `docs/archive/` | Dossiers prêts pour les décisions d'architecture et l'ancien PRD v3 |

## Mise en route

1. Préparer les prérequis de l'ordre 0 (PRD section 2) : compte GitHub, Node.js LTS, Rust, Visual Studio Build Tools, Claude Code.
2. Créer le dépôt privé `circletasks`, y décompresser ce kit, puis faire un premier commit.
3. Copier l'ancien PRD v3 et le scaffold Expo dans `docs/archive/`.
4. Ouvrir un terminal à la racine du dépôt et lancer `claude`.
5. Première demande à Claude Code :

   > Lis CLAUDE.md, docs/PRD.md et docs/backlog.md. Avec l'agent product-owner, traite les tâches PREP-02 à PREP-04, puis propose-moi le plan de l'ordre 1 avant d'écrire du code.

6. Ensuite, story par story : `Traite la prochaine story du backlog.` Le circuit product-owner → agent du module → qa-test → code-reviewer s'applique automatiquement.

## Rappels

- Les comptes Google Cloud, iCloud et la clé de signature ne sont nécessaires qu'aux ordres indiqués dans le PRD (section 2).
- La vérification iPhone (POC-01) se fait juste après l'ordre 1 : ne pas la sauter.
- Les rappels ne sonnent que sur l'iPhone : ils sont préparés à l'ordre 1 et envoyés à partir de l'ordre 5.
- Toute nouvelle idée de fonction passe d'abord par une mise à jour de `docs/PRD.md`.
