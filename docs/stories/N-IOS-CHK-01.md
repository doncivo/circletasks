# N-IOS-CHK-01 — Pourcentages dans les notifications iPhone

Module : notifications / QA native · Estimation **1 h**, alerte **1,5 h** · Statut : protocole préparé ; **essai physique non exécuté**, aucun correctif de production.

## Passe product-owner — 2026-10-21

L'audit signale que le natif peut traiter titre et corps comme des clés de localisation ; il demande de confirmer sur iPhone si les `%` sont déformés. Le navigateur ne prouve pas le rendu de UserNotifications. Ne pas corriger à l'aveugle, ne pas lancer de seconde compilation : utiliser l'IPA du lot terminé. La compilation Swift, la réception réelle et les aperçus sont distincts des tests de frontière de N-IOS-FIX-01.

## Essai d'Ali, dans cet ordre

1. Noter la version de l'IPA, la version iOS et le réglage habituel « Afficher les aperçus » ; choisir temporairement « Toujours » → le contenu complet peut être lu sur l'écran verrouillé.
2. Dans Réglages > Espaces et projets, noter le nom actuel de l'un des deux espaces, puis le renommer temporairement **`50 % %u`** → ce nom exact apparaît dans l'app. Les espaces sont renommables selon ES-01 ; ne créer ni supprimer d'espace.
3. Dans cet espace, créer **`Essai % · 50 % · %u`**, avec une heure à quelques minutes, hors plage silencieuse, et un rappel « À l'heure » → la tâche et son espace gardent ces caractères exacts dans l'app.
4. Verrouiller l'iPhone et attendre ce rappel, puis déployer la notification si son titre est tronqué → titre **`Essai % · 50 % · %u`**, corps **`HH:MM · 50 % %u`** avec l'heure de la tâche, sans remplacement par un compteur, suppression des `%`, texte vide ou plantage. Noter séparément le verdict du titre et du corps et faire une capture.
5. Synchroniser et vérifier la tâche sur PC → titre et nom d'espace strictement identiques. Le simulateur de navigateur ne remplace pas cette observation native.
6. Remettre le nom d'espace noté au départ, synchroniser et rétablir le réglage d'aperçus habituel → les deux appareils retrouvent le nom initial, les autres tâches restent présentes, le choix de confidentialité est restauré.
7. Exécuter aussi le cas « Aperçus masqués » du guide → le texte générique de catégorie ne révèle pas le titre utilisateur ; ce texte ne contient aucun `%` selon le contrat vérifié de N-IOS-FIX-01.

## Résultat et passage

Le guide `docs/essais-iphone.md`, cas 13, renvoie à ce protocole. Reporter version, heure, capture et résultat distinct titre/corps. **Aucun succès physique n'est présumé**. Si la déformation est confirmée, conserver sa preuve rouge et son contexte avant correctif ; le constat est un bloquant à traiter avant la 1.0 selon l'audit. Si le résultat est littéral sur les deux champs, consigner la preuve et clore le contrôle. Sans téléphone, rester « protocole prêt, appareil à vérifier ».

## Passes de vérification du protocole

Demande d'Ali : guide complet montré avant compilation. Ajouts : contrôle distinct copie locale / inclusion et réussite de sauvegarde iCloud, séquence SideStore N → N+1 détaillée, relevé des écarts à chaque essai, matrice des douze parcours REL-01 sans rejeu manuel des preuves automatiques. Sources Apple vérifiées ; aucune promesse de restauration SideStore déduite d'une date iCloud. A6 différé et A9 natif ouvert sont explicites. Revue documentaire distincte approuvée sur ces critères ; aucun essai physique déclaré passé, aucun build lancé à ce stade.

Passe QA documentaire : références à ES-01 et au guide relues ; renommage d'espace existant vérifié dans le code et ses tests, aucune création/suppression d'espace demandée. Le titre et le corps natifs reçoivent chacun des `%`, le réglage de confidentialité et le nom initial sont restaurés en fin d'essai. Les cinq régressions restent en tête ; douze parcours fonctionnels et I-06 sont explicités sans prétendre les avoir exécutés sur appareil.

Passe code-reviewer distincte : protocole et diff du guide relus à froid, **approuvés côté préparation** ; aucune donnée réelle lue par Codex, aucune modification applicative, aucun contournement des preuves natives. Lint, typage, bundle et CI complète restent requis avant fusion documentaire. **Le contrôle physique reste non fait**, même après cette fusion.
