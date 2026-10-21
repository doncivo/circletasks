# REL-03 — Préparation et publication du lot 1.0

Statut : préparation de l'IPA candidate ; livraison et essais physiques ouverts. Estimation préparation/publication : 2 h actives, alerte 3 h ; temps des runners et essais d'Ali distincts.

## Passe product-owner

Demande d'Ali : montrer le guide complet avant compilation, puis compiler et publier sans nouvelle consultation. Une seule nouvelle compilation fournit N+1 ; N est l'IPA installée. Version candidate 1.0.0 dans package, lock npm, Tauri, Cargo et lock Cargo. Notes honnêtes sur les critères physiques ouverts ; aucun tag PC ni clôture de REL-01/REL-02 déduit de la publication iPhone.

La publication existante est limitée aux tags ios-v*. Le workflow accepte soit un push du tag, soit un lancement manuel sur ce tag : employer un seul déclenchement, jamais les deux, ne pas écraser un tag existant. Publier uniquement le commit intégré via PR, revue et CI complète verte ; guide intégré et montré au préalable. Contrôler IPA, identifiant, version, empreinte et source SideStore après Actions.

## Vérifications à consigner

Intégration finale préparée après #75 (guide, 865c8729) et #77 (Vite, f9d7d242), chacune après 48 CI verts. Diff à froid depuis ce main : seulement les six versions racines, notes et documentation ; aucun changement applicatif ni transitif supplémentaire. **Revue finale de préparation approuvée**. Dépendances installées par `npm ci --ignore-scripts` depuis le lock : Vite 8.3.3, audit zéro avis ; contrat v1.0.0 vert. Les 48 verts historiques de b58d0df ne valent pas la CI de cette intégration : nouvelle validation requise avant fusion, puis mesure sur main avant le tag.

Bundle final avant push de l'intégration : **58/58, 338 476 normalisés, 338 433 bruts, marge 19 924**, Vite 8.3.3 et version 1.0.0 effectifs, gardes inchangées. Lint/typage de la préparation et du patch Vite verts, outils release/SideStore 75/75 ; CI complète de la nouvelle tête toujours exigée avant fusion et compilation. Scan secrets avant push, puis contrôle du tag inexistant avant lancement unique.

QA préparatoire : contrat de version `v1.0.0` et notes extraites avec succès ; **75 tests / 4 fichiers** des outils release/SideStore verts, couverture coupée. Diff des cinq fichiers de version relu séparément : seules les six occurrences de la version racine changent, aucune dépendance mise à jour. Guides PC corrigés pour retirer le recours à l'installeur quand la bannière manque et l'ancienne attente d'approbation humaine. Revue distincte de la préparation approuvée ; lint, typage et mesure finale en cours, CI complète requise avant fusion. Ne pas confondre cette préparation avec REL-03 livré.

Contrat de version et extraction des notes ; tests des outils de publication et SideStore ciblés sans couverture ; lint, typage, revue distincte ; bundle avant push et après fusion, scan secrets, CI complète. Compilation Swift et publication réelles restent ouvertes jusqu'au run iOS vert. Signature Windows, manifeste updater et guides de livraison seront vérifiés séparément ; sur PC aucune mise à jour par installeur manuel.
