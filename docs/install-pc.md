# Installer et mettre à jour CircleTasks sur le PC

Ce guide est pour le PC Windows (Windows 10 ou 11). Les versions PC sont publiées dans le dépôt public `doncivo/circletasks-releases` (`CircleTasks_X.Y.Z_x64-setup.exe`, sa signature `.sig` et `latest.json`). La publication elle-même est décrite dans `docs/release-pc.md`.

## Où vivent les données

- Base, sauvegardes locales et journal technique : `%APPDATA%\fr.circletasks.planner` (`circletasks.db`, `backups\`, `logs\`, `sync\`).
- Données du moteur web : `%LOCALAPPDATA%\fr.circletasks.planner`.
- Clé de synchro et jetons d'agenda : Gestionnaire d'identification Windows (coffre système), hors de ces dossiers.
- Programme installé : `%LOCALAPPDATA%\CircleTasks` (installation « utilisateur courant »), raccourci « CircleTasks » dans le menu Démarrer.

## Mettre à jour : la voie sûre, depuis l'app

1. Ouvrir CircleTasks. Elle contrôle `latest.json` 5 secondes après le lancement, puis périodiquement.
2. Quand la bannière « Nouvelle version » apparaît, appuyer sur **Installer**. L'app télécharge l'installeur signé, le lance en mode passif avec l'indicateur de mise à jour, et redémarre.
3. Dans ce mode, l'installeur **ne désinstalle pas** la version précédente et **ne touche jamais** aux dossiers de données : base, sauvegardes, journal et réglages restent en place.

C'est la seule voie à utiliser pour une mise à jour. Elle a été vérifiée le 2026-10-17 (0.1.1 → 0.3.3, modèle NSIS de Tauri 2.12.1).

## Installer à la main (première installation, ou si la bannière ne vient pas)

1. Télécharger `CircleTasks_X.Y.Z_x64-setup.exe` depuis la page des versions de `circletasks-releases`.
2. Lancer l'installeur. Si une version est déjà installée, l'installeur propose une page « La version … est installée sur le système » avec deux choix.
3. Choisir **« Ne pas désinstaller »**. L'installeur remplace le programme en place et garde les données.
4. Si tu choisis quand même « Désinstaller avant d'installer », le désinstalleur de l'ancienne version s'ouvre et affiche une case **« Supprimer les données de l'application »**.

> **⚠️ Ne jamais cocher « Supprimer les données de l'application ». Cette case efface sans confirmation supplémentaire `%APPDATA%\fr.circletasks.planner` et `%LOCALAPPDATA%\fr.circletasks.planner` : la base, toutes les sauvegardes locales, le journal technique et les réglages. Un seul clic suffit, et rien ne les met à la corbeille.**

La même case existe quand on désinstalle CircleTasks depuis « Paramètres › Applications ». Elle est décochée par défaut.

**Depuis la première version publiée après REL-TECH-02 (voir CHANGELOG, section « Non publié » puis son numéro), la case « Supprimer les données de l'application » est sans effet : elle reste affichée, mais les données sont toujours conservées**, que l'on désinstalle depuis Windows, avec `uninstall.exe` ou par « Désinstaller avant d'installer » (crochet NSIS, `src-tauri/windows/hooks.nsh`, décision 9 de l'audit 1.0). Le test de fumée Windows le vérifie à chaque suite sur un vrai installeur.

**Attention : avant cette version, cocher cette case supprime vos données.** Ce cas reste possible tant qu'une version antérieure est installée : si tu installes la première version avec crochet par-dessus une ancienne en choisissant « Désinstaller avant d'installer », c'est le désinstalleur de l'ANCIENNE version qui s'exécute et sa case reste active. Dans ce cas, choisir « Ne pas désinstaller » ou laisser l'app se mettre à jour elle-même.

### Effacer volontairement les données

Il n'existe plus de désinstallation « avec données ». Pour repartir de zéro : quitter CircleTasks (zone de notification › Quitter), puis supprimer à la main `%APPDATA%\fr.circletasks.planner` et `%LOCALAPPDATA%\fr.circletasks.planner` (explorateur de fichiers, ou `Remove-Item -Recurse` dans PowerShell). Rien ne va à la corbeille : copier d'abord `backups\` si tu veux le garder.

## Si les données ont été effacées malgré tout

Ce qui s'est passé le 2026-10-17 et ce que fait l'app :

- La clé de synchro est dans le coffre Windows : au premier lancement, l'app retrouve le dossier iCloud Drive, se présente comme un **nouvel appareil** et reprend tout ce qui a été synchronisé (tâches, routines, événements, rappels, agendas, jours fériés) depuis l'instantané et les journaux des autres appareils. Aucune réassociation n'est nécessaire.
- L'ancien appareil reste visible dans Réglages › Synchronisation › Détails comme un PC jamais revu : l'oublier depuis l'un des deux appareils (« Oublier cet appareil », confirmation native).
- Perdu pour de bon : les sauvegardes locales d'avant l'effacement, l'historique du journal technique, les réglages locaux (filtre d'espace, compteurs de consentement). Les données qui n'avaient jamais été synchronisées (hors ligne depuis le dernier cycle) sont perdues aussi : d'où l'importance de laisser un cycle passer avant toute manipulation d'installation.

## Vérifier quelle version tourne

Réglages › À propos affiche la version. Le journal technique (Réglages › Journaux) porte une ligne `app-updated <ancienne> <nouvelle>` à chaque changement de version. Si un vieux binaire ouvre une base plus récente, l'écran d'échec explique « Cette version de CircleTasks est plus ancienne que vos données » et renvoie à la page des versions (depuis la 0.2.1 ; la 0.1.1 n'affichait que « Impossible d'ouvrir la base de données »).
