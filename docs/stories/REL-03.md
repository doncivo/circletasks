# REL-03 — Préparation et publication du lot 1.0

## Paquet A — 1.0.1, suivi du 24 octobre 2026

UI-FIX-02 est intégré par #83 dans b8ddc85f, tête 80970c6c, 48 CI verts (40089223693 / 40089225629), revue approuvée. Nouvelle tâche et Détail attendent toujours les maquettes hors corrections explicitement demandées. Version 1.0.1, schéma 19 et protocole inchangés. Mesure main après fusion et artefacts de publication à vérifier ; ne pas annoncer de build reçu avant leur succès. Une seule compilation iPhone pour le paquet, même source pour PC et iPhone. PC uniquement par bannière. Les paragraphes 1.0.0 ci-dessous restent l'historique du candidat précédent ; ils ne constituent pas une preuve native de la 1.0.1.

## Décision applicable — 21 octobre 2026

A9 — récupération après migration interrompue, non vérifiée sur appareil réel. Décision d'Ali du 21 octobre 2026 : risque accepté pour l'usage mono-utilisateur. À reprendre obligatoirement si l'app devient multi-utilisateur ou distribuée à des tiers.

A9 n'est plus bloquant avant un changement de schéma ni pour la 1.0 en usage personnel. Il redevient bloquant si et seulement si l'app sort de l'usage personnel d'Ali ; sa vérification est alors obligatoire avant toute distribution à des tiers ou utilisation multi-utilisateur. Ce statut est un trou assumé, pas une story reportée ni un essai réussi.

Cette décision remplace les exigences A9 antérieures conservées ci-dessous pour historique. Aucun banc isolé ni séance A9 à lancer. Les preuves automatiques existantes sont conservées, sans les assimiler à un essai d'appareil. A6b reste « vérifié en usage après la 1.0 » : vérification future, non faite et non bloquante. Les autres essais natifs restent ouverts ; REL-01 à REL-03 ne sont pas clos sans leurs résultats.


Statut : candidats PC et iPhone 1.0.0 publiés et vérifiés ; A9 : risque accepté ; recette physique ouverte, livraison non prononcée. Estimation préparation/publication : 2 h actives, alerte 3 h ; temps des runners et essais d'Ali distincts. A9 : périmètre séparé explicitement autorisé à 6 h, fiche I-06-A9.

Publication PC : run **39616432734** vert ; EXE téléchargé sans exécution, signature Ed25519 et version signée 1.0.0 valides ; SHA-256 **b303d07a077bc6c5dfe021090af9c7d73f3dd91bdcb34d7568dd188d7ed7ede2**, conforme à l'asset GitHub. L'endpoint public `releases/latest/download/latest.json` sert 1.0.0 avec la signature du fichier téléchargé. Mise à jour d'Ali uniquement par la bannière, aucun installeur lancé à la main. La publication des candidats ne clôt pas la recette.

**Historique annulé — A9 bloquait la livraison 1.0**, décision précédemment confirmée d'Ali après constat du changement 18 vers 19. Voir `docs/stories/I-06-A9.md` et `docs/essais-iphone-a9.md`. Les deux builds instrumentés sont réservés aux essais, sans publication SideStore, et ne remplacent pas le candidat correct ; aucun résultat physique encore acquis.

## Passe product-owner

Demande d'Ali : montrer le guide complet avant compilation, puis compiler et publier sans nouvelle consultation. Une seule nouvelle compilation fournit N+1 ; N est l'IPA installée. Version candidate 1.0.0 dans package, lock npm, Tauri, Cargo et lock Cargo. Notes honnêtes sur les critères physiques ouverts ; aucun tag PC ni clôture de REL-01/REL-02 déduit de la publication iPhone.

La publication existante est limitée aux tags ios-v*. Le workflow accepte soit un push du tag, soit un lancement manuel sur ce tag : employer un seul déclenchement, jamais les deux, ne pas écraser un tag existant. Publier uniquement le commit intégré via PR, revue et CI complète verte ; guide intégré et montré au préalable. Contrôler IPA, identifiant, version, empreinte et source SideStore après Actions.

## Vérifications à consigner

Intégration finale préparée après #75 (guide, 865c8729) et #77 (Vite, f9d7d242), chacune après 48 CI verts. Diff à froid depuis ce main : seulement les six versions racines, notes et documentation ; aucun changement applicatif ni transitif supplémentaire. **Revue finale de préparation approuvée**. Dépendances installées par `npm ci --ignore-scripts` depuis le lock : Vite 8.3.3, audit zéro avis ; contrat v1.0.0 vert. Les 48 verts historiques de b58d0df ne valent pas la CI de cette intégration : nouvelle validation requise avant fusion, puis mesure sur main avant le tag.

Bundle final avant push de l'intégration : **58/58, 338 476 normalisés, 338 433 bruts, marge 19 924**, Vite 8.3.3 et version 1.0.0 effectifs, gardes inchangées. Lint/typage de la préparation et du patch Vite verts, outils release/SideStore 75/75 ; CI complète de la nouvelle tête toujours exigée avant fusion et compilation. Scan secrets avant push, puis contrôle du tag inexistant avant lancement unique.

QA préparatoire : contrat de version `v1.0.0` et notes extraites avec succès ; **75 tests / 4 fichiers** des outils release/SideStore verts, couverture coupée. Diff des cinq fichiers de version relu séparément : seules les six occurrences de la version racine changent, aucune dépendance mise à jour. Guides PC corrigés pour retirer le recours à l'installeur quand la bannière manque et l'ancienne attente d'approbation humaine. Revue distincte de la préparation approuvée ; lint, typage et mesure finale en cours, CI complète requise avant fusion. Ne pas confondre cette préparation avec REL-03 livré.

Contrat de version et extraction des notes ; tests des outils de publication et SideStore ciblés sans couverture ; lint, typage, revue distincte ; bundle avant push et après fusion, scan secrets, CI complète. Compilation Swift et publication réelles restent ouvertes jusqu'au run iOS vert. Signature Windows, manifeste updater et guides de livraison seront vérifiés séparément ; sur PC aucune mise à jour par installeur manuel.

## REL-03 : séance A9 prête, preuve physique attendue (2026-10-21)

#80 fusionnée dans main 2398e8e2 après 48 CI verts de d67692ae (39638601218 / 39638593312). Deux builds A9 réussis, artefacts téléchargés et vérifiés : afterapply 39637333456 et interruption 39637672577. Contrat des cinq plugins, version/build 1.0.0, identifiant fr.circletasks.planner et minimum 18.0 conformes.

Paquet A9-seance-4-IPA.zip : 29 328 763 octets ; SHA-256 e8b7d51a8d129a9b4e203ff047daca4bb51d403e155ef7c138cd8aa3db9d880a, identique au digest GitHub. Quatre IPA internes relues et hachées depuis le ZIP : chacune concorde avec son empreinte ; deux guides, mémo et SHA256SUMS inclus, huit entrées. Brouillon non publié a9-20261021-cff59f5c ; aucun ajout à la source SideStore publique (blob 5a8af39e2a3f10209bf965f131ca1483b95dcd39 inchangé).

Guide et paquet transmis à Ali ; créneau physique de 60 à 75 minutes. A9 reste **non exécuté sur appareil** et bloque la livraison. Après A9 restent les frontières natives du guide et le verdict final REL-01/REL-02/REL-03. A6b : « vérifié en usage après la 1.0 », futur, non fait, non bloquant. Aucun worktree supprimé.

Passe QA de remise : les quatre entrées IPA ont été hachées depuis le ZIP, puis le digest de l'asset GitHub comparé à celui du ZIP local ; toutes les vérifications concordent. Mesure après fusion #80 et avant push de cette consignation : 58/58, 338 476 normalisés, 338 433 bruts, marge 19 924 ; typage exécuté par le build de cette mesure. Passe code-reviewer distincte : **revue de remise approuvée**, diff limité aux preuves, aux liens, aux statuts et à un commentaire du générateur ; aucun code applicatif ni comportement d'injection modifié. CI complète de la branche exigée avant intégration de cette consignation ; aucune clôture des essais physiques par déduction.
