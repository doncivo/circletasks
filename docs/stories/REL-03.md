# REL-03 — Préparation et publication du lot 1.0

Statut : préparation de l'IPA candidate ; livraison et essais physiques ouverts. Estimation préparation/publication : 2 h actives, alerte 3 h ; temps des runners et essais d'Ali distincts.

## Passe product-owner

Passe publication PC du lot : préparer le même candidat 1.0.0 pour que la séance couvre aussi I-06 A7 sur le PC par la bannière updater. Cette publication fait partie de REL-03 déjà autorisée ; elle ne transforme pas les essais physiques en succès. Après l'intégration de l'audit #79, tag **v1.0.0** sur main avec CI verte et bundle mesuré ; jamais de lancement de l'installeur sur le PC réel par Codex, ni de demande d'installation manuelle à Ali. Vérifier ensuite les fichiers publiés, la signature hors ligne avec la clé publique, le manifeste réellement servi par l'endpoint updater et la conservation de source.json iPhone. Garder le verdict final de recette ouvert jusqu'aux observations d'appareil.

Précontrôles : tag v1.0.0 et release correspondante absents au contrôle ; environnement releases autorise v*, secrets présents par nom seulement ; workflow compilant sans clé updater puis signant dans une étape séparée relu. Aucun secret extrait. Version iPhone déjà publiée par l'unique run 39605174348 ; aucun nouveau build iPhone pour le PC ni pour les documents. Branche de consignation rel-03-publication-1-0, depuis le dossier d'audit, non publiée à ce stade.

Source PC gelée : **c5fc22ee9da64279abcf84fb5ae0ad54c4135836**, arbre égal à 241daa87 validé par 48 CI ; diff applicatif et dépendances avec ios-v1.0.0 vide. Bundle main 58/58, 338 476 normalisés, marge 19 924. #79 est ensuite fusionnée dans **7247f4a6** après 48 CI verts (39610631299 / 39610959208) ; changements documentaires uniquement, même mesure main après fusion.

Déclenchement Windows : tag annoté v1.0.0 créé à 14:05:52 UTC, objet **64ff8d1a2aed1e8ac774f95eddc10598635430d5**. Aucun run listé après plusieurs vérifications, workflow actif, filtre identique aux versions précédentes, aucun échec de test constaté. Cause de l'absence d'événement non prouvée. Après mesure 58/58 avant réémission, absence de release et de run revérifiée, référence retirée puis recréée **avec le même objet et le même commit**, sans force-push, via l'authentification propriétaire gh appliquée à cette seule commande git. Aucune configuration globale ni clé modifiée. Ne pas assimiler cette réémission d'événement à une preuve de compilation ou publication : attendre les jobs réels et vérifier les artefacts.

Demande d'Ali : montrer le guide complet avant compilation, puis compiler et publier sans nouvelle consultation. Une seule nouvelle compilation fournit N+1 ; N est l'IPA installée. Version candidate 1.0.0 dans package, lock npm, Tauri, Cargo et lock Cargo. Notes honnêtes sur les critères physiques ouverts ; aucun tag PC ni clôture de REL-01/REL-02 déduit de la publication iPhone.

La publication existante est limitée aux tags ios-v*. Le workflow accepte soit un push du tag, soit un lancement manuel sur ce tag : employer un seul déclenchement, jamais les deux, ne pas écraser un tag existant. Publier uniquement le commit intégré via PR, revue et CI complète verte ; guide intégré et montré au préalable. Contrôler IPA, identifiant, version, empreinte et source SideStore après Actions.

## Vérifications à consigner

Intégration finale préparée après #75 (guide, 865c8729) et #77 (Vite, f9d7d242), chacune après 48 CI verts. Diff à froid depuis ce main : seulement les six versions racines, notes et documentation ; aucun changement applicatif ni transitif supplémentaire. **Revue finale de préparation approuvée**. Dépendances installées par `npm ci --ignore-scripts` depuis le lock : Vite 8.3.3, audit zéro avis ; contrat v1.0.0 vert. Les 48 verts historiques de b58d0df ne valent pas la CI de cette intégration : nouvelle validation requise avant fusion, puis mesure sur main avant le tag.

Bundle final avant push de l'intégration : **58/58, 338 476 normalisés, 338 433 bruts, marge 19 924**, Vite 8.3.3 et version 1.0.0 effectifs, gardes inchangées. Lint/typage de la préparation et du patch Vite verts, outils release/SideStore 75/75 ; CI complète de la nouvelle tête toujours exigée avant fusion et compilation. Scan secrets avant push, puis contrôle du tag inexistant avant lancement unique.

QA préparatoire : contrat de version `v1.0.0` et notes extraites avec succès ; **75 tests / 4 fichiers** des outils release/SideStore verts, couverture coupée. Diff des cinq fichiers de version relu séparément : seules les six occurrences de la version racine changent, aucune dépendance mise à jour. Guides PC corrigés pour retirer le recours à l'installeur quand la bannière manque et l'ancienne attente d'approbation humaine. Revue distincte de la préparation approuvée ; lint, typage et mesure finale en cours, CI complète requise avant fusion. Ne pas confondre cette préparation avec REL-03 livré.

Contrat de version et extraction des notes ; tests des outils de publication et SideStore ciblés sans couverture ; lint, typage, revue distincte ; bundle avant push et après fusion, scan secrets, CI complète. Compilation Swift et publication réelles restent ouvertes jusqu'au run iOS vert. Signature Windows, manifeste updater et guides de livraison seront vérifiés séparément ; sur PC aucune mise à jour par installeur manuel.
