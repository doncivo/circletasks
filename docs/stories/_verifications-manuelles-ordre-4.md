# Vérifications manuelles d'Ali, ordre 4 (synchro)

Établi par le product-owner le 2026-10-06 à partir des fiches Y-01 à Y-11 et A-09. Tout se fait sur le seul PC Windows (iCloud pour Windows installé, dossier `iCloud Drive\CircleTasks`). Une ligne par vérification, fiche d'origine entre parenthèses ; « v » = numéro dans la section « Vérifications manuelles » de la fiche. Les lignes marquées « ajoutée » comblent un critère que la fiche ne renvoyait à aucune vérification.

## À faire sur le PC seul

1. Réglages > Synchronisation > « Choisir le dossier » : la boîte propose `iCloud Drive\CircleTasks`, la ligne affiche « iCloud Drive / CircleTasks » sans avertissement, et le choix survit au redémarrage (Y-01 v1).
2. Après « Oublier le dossier », choisir un dossier hors iCloud (`C:\Temp\ct-test`) : l'avertissement « Ce dossier n'est pas dans iCloud Drive » s'affiche (Y-01 v2).
3. Choisir une jonction (`mklink /J`), un lecteur réseau puis un lecteur `SUBST` : refus avec « Ce dossier ne peut pas servir à la synchronisation » (Y-01 v3).
4. « Oublier le dossier et la clé » : confirmation avec « Annuler » par défaut, puis l'entrée `circletasks.sync.key.v1` disparaît du Gestionnaire d'identification (Y-01 v4).
5. `cargo test -- --ignored` avec `CT_SYNC_TEST_DIR` sur un sous-dossier iCloud « en ligne seulement » : le contenu est lu, pas la balise (Y-01 v5).
6. Même test avec iCloud pour Windows arrêté : message « Ouvrez iCloud pour Windows », aucun plantage (Y-01 v6).
7. Après le choix du dossier, l'entrée `circletasks.sync.key.v1` existe et aucun fichier de `iCloud Drive\CircleTasks` ne contient la clé ; elle est toujours là après l'association de la vérification 31 (Y-08 v1, Y-06 v8).
8. Un fichier `.ctj` ou `state.ctx` ouvert dans le Bloc-notes : ligne 1 en JSON clair, lignes suivantes opaques ; `devices\<uuid>\` contient `state.ctx` et `e0001-…\j-00000001.ctj` (Y-08 v3, Y-02 v1).
9. Créer la tâche « Test synchro » : le segment grandit au cycle suivant (paliers de 4 Kio) et le titre reste introuvable dans les fichiers (Y-02 v2).
10. Clic droit sur son propre `state.ctx` > « Libérer de l'espace », puis « Synchroniser » : relu sans erreur, pas de « Dossier introuvable » (Y-02 v3).
11. Quitter iCloud pour Windows, créer deux tâches, modifier l'une, « Synchroniser » : l'app reste fluide, la ligne dit que le dossier ou iCloud est indisponible ; relancer iCloud : « À jour », rien de perdu (Y-02 v4, Y-05 v1).
12. Mode avion, créer une tâche, « Synchroniser » : « À jour » (publication locale) et le bandeau « Hors ligne » reste visible (Y-05 v2).
13. Fermer brutalement l'app juste après une modification (Gestionnaire des tâches), relancer : la modification est présente et publiée au cycle suivant (Y-05 v3).
14. Restaurer une sauvegarde P-04 : la fenêtre de choix apparaît à la synchro suivante, aucune synchro avant le choix, les deux options répondent ; « Synchroniser » rouvre la fenêtre au lieu de lancer un cycle (Y-02 v5, Y-03 v4).
15. Clic droit sur l'icône de la zone de notification : « Synchroniser maintenant » présent, en français puis en anglais ; le clic ne montre pas la fenêtre et « à l'instant » apparaît dans Réglages (Y-03 v1).
16. Réglages > « Synchroniser » : bouton grisé le temps du cycle puis « À jour · à l'instant » (Y-03 v2).
17. Après « Oublier le dossier », « Synchroniser maintenant » depuis la zone de notification : la fenêtre s'ouvre sur Réglages > Synchronisation (Y-03 v3).
18. Au clavier réel : Tab atteint « Synchroniser », Entrée puis Espace le déclenchent (Y-03 critère 8, jsdom ne le prouve pas ; ajoutée).
19. Détails de la synchro avec un seul PC : « Aucun conflit », pas de bloc « JOURNAL DES CONFLITS » (Y-04 v1).
20. `npx playwright test tests/e2e/parcours/J10-conflit-hors-ligne.spec.ts --headed --project=pc` : regarder le conflit, « Restaurer », « Annuler » ; comparer à Synchro.html (Y-04 v2).
21. Décider si `test.slow()` dans J10 (délai triplé, 12 à 18 s sous 30 s) est acceptable (Y-04, défaut 5 « à confirmer par Ali »).
22. « Associer l'iPhone » : boîte native avec « Annuler » par défaut (Entrée = refus), pas de boîte si l'app est en arrière-plan (Y-06 v1, Y-08 v2).
23. Fenêtre `pairing` : QR, clé `CT1-…`, « Code valable 5 minutes » qui décompte, « En attente de l'iPhone… » (Y-06 v2).
24. Capture d'écran (Win+Maj+S, Xbox Game Bar) pendant l'affichage : la fenêtre `pairing` est noire, le reste capturé (Y-06 v3).
25. « Imprimer la clé de secours » : l'avertissement d'abord, puis PDF (Microsoft Print to PDF) avec la clé seule, sans QR (Y-06 v4).
26. « Nouveau code » : nouvelle boîte de confirmation et code changé ; la 4e demande en 10 minutes est refusée avec le message prévu (Y-06 v5).
27. Fermer la fenêtre `pairing` par « Annuler », Échap, la croix, la réduction de la fenêtre principale et 5 minutes d'attente : elle disparaît à chaque fois (jamais masquée), rouvrir redemande la confirmation (Y-06 v6).
28. Dans la fenêtre `pairing` : clic droit, Ctrl+S, Ctrl+P, Ctrl+Maj+S, F5, Ctrl+F, F12 sans effet, aucun remplissage automatique ; deux ouvertures de suite : « La fenêtre d'association est déjà ouverte » (Y-06 v10 bis).
29. `npm run tauri build`, installer le `.exe` : « Associer l'iPhone » ouvre bien la page (contrôle de production) (Y-06 v9).
30. Réglages > relancer l'assistant du premier lancement : étape « Synchronisation » passable, « Étape n sur 4 » (Y-06 v10).
31. Substitut du second appareil : noter la clé de secours, « Oublier le dossier et la clé », rechoisir le dossier, « Associer cet appareil », saisir la clé en minuscules avec des espaces : associé, tâches intactes ; une clé fausse (un caractère changé) est refusée sans rien enregistrer (Y-06 v7).
32. Supprimer une tâche, ouvrir la corbeille, la restaurer, avec le dossier lié puis sans : aucune différence avec T-08, aucun message d'erreur (Y-09 v1 et v2).
33. Avancer la date du PC de plus d'une heure, créer une tâche, resynchroniser : l'app ne se bloque pas (Y-09 v3).
34. Lancer l'app avec la synchro configurée : aucun bandeau « Mettez à jour l'app », aucune ligne « version plus récente » dans les détails (Y-07 v1).
35. Après l'installation d'une version suivante de CircleTasks : la synchro reprend sans erreur, aucun champ perdu (Y-07 v2).
36. Détails de la synchro avec le seul PC : aucun bouton « Oublier cet appareil », aucune ligne « Oublié » (Y-10 v1).
37. `npx playwright test tests/e2e/parcours/Y10-oublier-appareil.spec.ts --headed --project=pc` : relire la confirmation, la ligne « Oublié · suppression… en attente », le bandeau « Cet appareil a été oublié », « Associer de nouveau » (Y-10 v2).
38. Dans la page de l'appareil oublié, mode hors ligne du navigateur pendant un oubli : l'échec ou l'attente reste affiché en rouge après rechargement (Y-10 v3).
39. « Réinitialiser la synchronisation » : lire l'avertissement (ancienne clé de secours, copies déjà prises) ; boîte native avec « Annuler » par défaut, absente en arrière-plan (Y-11 v1).
40. Confirmer : nouvelle clé `CT1-…` dans la fenêtre noire, avertissement « l'ancienne clé de secours ne sert plus », impression en deux temps, « À jour », toutes les tâches présentes (Y-11 v2).
41. Dans `iCloud Drive\CircleTasks` : ancienne époque disparue, un seul dossier d'époque, aucun titre ni clé dans les fichiers ; coffre : `.v1` présent, `.next` absent (Y-11 v3).
42. « Oublier le dossier et la clé », rechoisir le dossier, « Associer cet appareil » : l'ancienne clé de secours est refusée sans rien enregistrer, la nouvelle est acceptée (Y-11 v4).
43. Fermer brutalement l'app en pleine réinitialisation, relancer : l'écran dit qu'elle a été reprise, elle se termine, aucune tâche perdue (Y-11 v5).
44. Couper iCloud (ou renommer le dossier) avant de confirmer : l'échec reste affiché en rouge avec bandeau après redémarrage, jusqu'à la reprise (Y-11 v6).
45. `npx playwright test tests/e2e/parcours/Y11-reinitialiser.spec.ts --headed --project=pc` : relire la liste « appareils à réassocier », « Oublier cet appareil », le bandeau et « Cet appareil doit être associé de nouveau » (Y-11 v7).
46. Provoquer un état de synchro en échec (iCloud arrêté) et vérifier depuis l'écran Aujourd'hui le bandeau, son texte identique à celui de Réglages, « Voir », et sa disparition à la résolution (A-09 critère 9, aucune liste manuelle dans la fiche ; ajoutée).
47. Relecture finale des écrans composés sans maquette, en clair et en sombre, focus et Échap compris : ligne « Non configurée » et états d'erreur du dossier, détails, journal des conflits et message d'annulation, version, appairage, oublier, réinitialiser, choix après restauration, bandeaux (Y-01 à Y-11, A-09 ; Y-04 v3, Y-10 v4, Y-11 v8 ; thèmes et focus piégé de Y-10 critère 18, Y-11 critère 19, Y-06 critère 22).

## À faire à l'ordre 5 avec l'iPhone

La liste complète est dans `docs/stories/_checklist-ordre-5.md`. Les vérifications qui exigent un second appareil réel sont : parcours 10 (conflit réel PC et iPhone, Y-04), parcours 11 (scan du QR, tâche lisible sur l'iPhone, titre introuvable dans les fichiers, Y-06 et Y-08), version réelle différente (Y-07 v3), oubli de l'iPhone éteint (Y-10 v5), réinitialisation avec iPhone allumé puis éteint (Y-11 v9), fichier partiel ou dans le nuage d'un autre appareil (Y-05 v4), horloge en avance d'un autre appareil (Y-09 v3), lecture croisée d'un fichier d'autrui (Y-02 v6).
