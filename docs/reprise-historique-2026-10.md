# Historique des points de reprise — 19 au 27 octobre 2026

Archive figée le 2026-10-27, à la reprise par Claude Code. Ce fichier contient, tels qu'écrits, tous les points de reprise de `docs/reprise-codex.md` entre la passation du 2026-10-19 et la pause du 2026-10-27, du plus récent au plus ancien. Chaque section « prioritaire » ne valait qu'à sa date ; plusieurs se contredisent, par exemple « livraison 1.0 bloquée jusqu'à la preuve A9 » (21 octobre, matin) et la décision d'Ali du 21 octobre au soir qui lève A9. L'état courant et les décisions applicables sont dans `docs/reprise-codex.md` ; en cas de désaccord, ce fichier perd.

---

# (Archive) Reprise par Codex — passation du 2026-10-19 et suivi du palier 1.0

## PAUSE demandée par Ali le 27 octobre 2026

Instruction prioritaire : « tout consigné et mettre en pause ». Ne reprendre aucun développement, fusion ni compilation avant une nouvelle demande d'Ali. Les CI déjà lancées peuvent finir ; aucun résultat futur présumé, aucune surveillance active pendant la pause.

État sauvegardé : UI-FIX-03, correctif Rapport du mois, poussé dans la PR #88 ouverte, tête ef10846f59bb30babf9e435022f9dd7bce43895d. Preuve rouge e01b756e. QA locale : 59 ciblés, 13 e2e initiaux puis cinq complémentaires, lint/typage et 62 gardes bundle verts ; revue approuvée dans docs/stories/UI-FIX-03.md. Bundle 334 025 normalisés, 333 960 bruts, marge 24 375. CI 40490948417 / 40490975874 en cours au relevé de pause : 1 contrôle vert, 20 en cours, 23 en attente. Pas fusionné, pas livré. À la reprise, lire le résultat réel de #88 avant toute fusion et remesurer main après fusion.

Une branche UI-FIX-04 avait seulement été créée depuis ef10846f ; aucun test ni code Objectif écrit. Elle est renommée pause-refonte-20261027 pour ce point de sauvegarde documentaire, dans le worktree n-ios-apercus. Commit documentaire local, sans push ni nouveau lancement CI à la pause. Les modifications applicatives et leurs preuves sont déjà sur GitHub via #88. Main reste a33c2dbf, candidats PC/iPhone 1.0.2 déjà publiés, schéma 19 ; aucun nouvel artefact construit.

### Demande complète restant à exécuter

- 11 : Rapport, phrases « Aucune routine ce mois-ci », « Aucun objectif » au lieu d'un tiret. Inclus dans #88, avec distinction des données exclues par projet et des routines sans occurrence prévue.
- 12 : retour iOS à gauche partout. Rapport inclus dans #88 ; Objectif reste à corriger, puis vérifier les autres retours.
- 13 : Focus Time devient un titre français sans capitales ; Pause domine visuellement Terminer la tâche ; le total du jour ne reste plus à zéro pendant une première minute active (secondes ou minute entamée). Non commencé.
- 14 : Rapport, remplacer « complétion » par « achèvement » en conservant le ratio. Inclus dans #88, pas encore fusionné.
- 15 : Objectif, un seul moyen d'ajouter quand le champ de saisie est déjà présent. Non commencé ; piste lue : masquer le bouton d'ajout tant qu'un brouillon est ouvert, conserver l'ajout après création d'un objectif. Préserver saisie, focus et persistance.

Ensuite, une story par écran : Aujourd'hui iPhone clair/sombre, Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. Références dans docs/maquettes-refonte de #84, bd3a80bf : reprendre hiérarchie, espacements, formulations et règles, sans copier le HTML. Les huit écrans ne sont pas commencés. Preuve avant/après, revue consignée, CI verte, bundle après chaque fusion ; plafond inchangé. Les quatre seuls motifs d'arrêt restent ceux convenus, en plus de cette pause explicitement demandée. A9 reste accepté pour usage personnel, A6b futur ; aucun résultat natif 1.0.2 inventé.

## 27 octobre — cinq défauts puis huit écrans autorisés

Ali a fourni les points 11 à 15 et levé la pause des huit refontes. Ordre : Rapport (11/12/14, UI-FIX-03), Objectif (12/15), Concentration (13), puis Aujourd'hui iPhone clair/sombre, Semaine, Synchronisation, Routines, Checklists, Événements, Aujourd'hui PC, Réglages PC. Une story par écran, preuves avant/après, revue distincte, CI et bundle après chaque fusion. Référence docs/maquettes-refonte sur design-maquettes-refonte, PR #84, bd3a80bf : reprendre hiérarchie, espacements et formulations, pas copier le HTML. Aucun nouveau résultat physique 1.0.2 reçu.

Main a33c2dbf (#87 fusionnée, 48 contrôles verts ; bundle après fusion 62/62, 333 973 octets). UI-FIX-03 est désormais poussée en #88, état exact dans la section de pause ci-dessus. Estimation trois écrans de correctifs : 4 à 6 h actives ; premier écran 1 h 30 à 2 h, alerte 3 h. Racine sur design-maquettes-refonte conservée. Pas de deuxième compilation 1.0.2 ; un seul futur lot après le travail autorisé.

## Refonte 1.0.2 — publication vérifiée

UI-REFONTE-01 intégré par #86 ; PC et iPhone **1.0.2** publiés depuis **f473e113**, même code, schéma 19 inchangé. CI complète : runs **40297597829 / 40297604155** verts, revue approuvée. Bundle main après fusion **62/62, 333 973 normalisés, marge 24 427**, soit 5 225 octets économisés face à 1.0.1 ; plafond et couverture inchangés.

Builds réels **40300455346 (iPhone) / 40300455500 (PC)** verts. IPA **7363893 octets**, SHA-256 **89fda9b6cde29106e442e6553742debfbef323dc6000f9e5afac601e938e3675**, concordants avec l'asset et source SideStore ; version/build 1.0.2, fr.circletasks.planner, iOS minimum 18.0, contrat cinq plugins contrôlés. EXE **6406556 octets**, SHA-256 **aa231a03b9c5cb13e944ed7fec0ece26ac7dd0b99d01ff5bee239ed2e84a18d7**, signature Ed25519 et endpoint updater 1.0.2 vérifiés sans exécution. PC uniquement par bannière ; iPhone par SideStore sans désinstallation.

**Rendu natif de la refonte encore ouvert** : quatre contrôles seulement dans docs/essais-iphone.md. Les essais 1.0.1 sont acceptés par Ali, sans les réattribuer à 1.0.2. A9 reste le trou assumé ; A6b reste une vérification future en usage après la 1.0. Suivi documentaire sur rel-03-refonte-1-0-2 ; aucune recompilation pour ces textes.

Suite autorisée : terminer la PR documentaire de rel-03-refonte-1-0-2, attendre sa CI, fusionner et remesurer main. Ensuite seuls les quatre contrôles physiques du guide demandent Ali. Les préparations ci-dessous sont historiques ; les deux builds sont déjà publiés et ne doivent pas être relancés.

## Historique de préparation — remise après fusion #86

Main f473e113, #86 fusionnée après **48 CI verts de 5a97e8c6**, runs 40297597829 / 40297604155 ; arbre intégré identique à la tête revue. Bundle main **62/62, 333 973 normalisés, 333 984 bruts, marge 24 427**, plafond inchangé. Branche active de preuve documentaire **rel-03-refonte-1-0-2**, même worktree n-ios-apercus. Un seul push des tags v1.0.2 et ios-v1.0.2 sur f473e113 a lancé **iOS 40300455346 / Windows 40300455500**, en cours au dernier relevé. **Ne jamais relancer ni dispatcher un second build.** Attendre les sorties, télécharger dans .codex-tmp/node_modules/runtime/release-1.0.2, puis vérifier IPA/Info.plist/source et signature EXE/endpoint sans exécution. Scripts temporaires verify-refonte-release.mjs et document-refonte-release.mjs prêts dans le même runtime ; ce dernier exige les vrais source/run IDs et proof.json. Actualiser les sept documents, bundle avant push, secrets, PR documentaire/CI/fusion et mesure main ; aucune recompilation pour les textes. Guide de quatre contrôles montré avant compilation et déjà sur main. Attendre les deux candidats vérifiés avant de remettre la main à Ali pour le rendu natif ; ne pas rouvrir les essais 1.0.1 acceptés, A9 ni A6b.

## Historique de développement — UI-REFONTE-01, 26 octobre 2026

Ali demande la refonte de Nouvelle tâche et Détail uniquement, selon Ajout-v2 et Detail-v2 de #84 (bd3a80bf). Branche UI-REFONTE-01, worktree n-ios-apercus, PR #86 ouverte, base main 9ddb7781. La tête initiale a70393fe avait échoué en CI (40293615923 / 40293695880) : anciens accès aux options repliées, contraste dynamique, charge du banc perf et affichage des rappels inactifs. Complément corrigé et relu : **144 ciblés, six e2e, perf 700 ms CPU ×4, lint/typage, bundle 62/62 verts**. Mesure finale **333 973 normalisés, 333 984 bruts, marge 24 427**, dix autorisations retirées et une attribution CSS existante justifiée. Prochain : commiter/pousser le complément s'il reste local (sans force), attendre les deux CI complètes sur la tête réelle de #86, fusion --merge et mesure main ; un seul build iPhone 1.0.2 et un PC, contrôler/remettre les artefacts, puis intégrer leurs preuves documentaires sans recompilation. Aucun build 1.0.2 ni tag encore lancé. Schéma toujours 19. PR #84 intacte, autres écrans hors périmètre. Guide : quatre contrôles natifs nouveaux seulement ; essais 1.0.1 acceptés par Ali. A9 trou assumé, A6b futur. Racine personnelle sale conservée.

## 26 octobre 2026 — recette 1.0.1 reçue, refonte autorisée

Ali confirme dans la conversation la réussite des dix contrôles du paquet A et des autres essais natifs du guide. Attestation utilisateur, sans inventer de captures ni d'heures individuelles. Le paquet A et la recette du candidat 1.0.1 sont acceptés ; A9 reste le trou assumé, A6b reste une vérification future en usage après la 1.0. Les preuves automatiques et les artefacts déjà vérifiés restent ceux de #83 / #85.

Nouvelle demande : refonte de Nouvelle tâche et Détail, story UI-REFONTE-01, branche du même nom dans n-ios-apercus. Références Ajout-v2 / Detail-v2 de la PR #84, autres écrans exclus. Candidat 1.0.2 sans migration, schéma 19. Nouveau rendu non encore validé sur appareil ; ne pas lui attribuer la recette de 1.0.1. Estimation 6 à 8 h actives, alerte 12 h. Tests ciblés, revue, CI, bundle et publication à terminer avant remise.

## Paquet A — publication vérifiée du 24 octobre 2026

PC et iPhone **1.0.1** publiés depuis **b8ddc85f**, tags v1.0.1 / ios-v1.0.1 ; runs **40090523636 / 40090523848** verts. IPA : 7 356 612 octets, SHA-256 d1ba316c179036369a656ef718591ed3f8e2ba4dc5c332710d2bd80988244e97, asset/artefact/source SideStore concordants, Info.plist et contrat cinq plugins valides. Signature PC Ed25519 et endpoint updater 1.0.1 vérifiés sans exécuter l'EXE. Mise à jour PC exclusivement par bannière, puis iPhone SideStore sans désinstallation. Guide : docs/essais-iphone.md.

Bundle main après #83 : **58/58, 339 198 normalisés, 339 190 bruts, marge 19 202 octets**, plafond et liste de modules inchangés ; +722 octets pour le paquet. CI applicative 48/48, lint, typage et revue approuvée. **Vérification native du paquet et clôture REL-01 à REL-03 encore ouvertes** ; ne pas écrire « fait ». A9 reste le trou assumé décidé par Ali, A6b « vérifié en usage après la 1.0 » est futur, pas exécuté. Suivi documentaire sur rel-03-paquet-a-1-0-1 ; aucune recompilation pour ces textes.

## Priorité — paquet A UI-FIX-02 du 24 octobre 2026

Ali a testé l'iPhone 1.0.0 et demande dix correctifs dans l'ordre de `docs/stories/UI-FIX-02.md`. #83 fusionnée dans b8ddc85f après 48 CI verts de 80970c6c, runs 40089223693 / 40089225629 ; lint, typage et revue consignés, aucune validation native présumée. La première CI avait accusé des références de noms partagées : origine inconnue des sauvegardes conservée avec identifiant de secours, attentes des conflits et parcours adaptées sans suppression de test ni changement de délai. Branche de remise `rel-03-paquet-a-1-0-1`, worktree `n-ios-apercus`. Version 1.0.1 sans migration ; mesure main après fusion puis un seul build iPhone et un build PC sur ce commit, vérification des artefacts avant annonce. Ne pas modifier la mise en page de Nouvelle tâche/Détail avant les maquettes, hors corrections explicitement listées. Racine personnelle sale `passation-codex` conservée ; la consigne de périmètre ajoutée par cfa2c8f0 est conservée dans main, seuls les trois ajouts d'AGENTS diffèrent de la tête revue, pas le code applicatif. A9 reste un trou assumé, pas une tâche à relancer ; les paragraphes de préparation A9 ci-dessous sont historiques et annulés.

## Décision applicable — 21 octobre 2026

A9 — récupération après migration interrompue, non vérifiée sur appareil réel. Décision d'Ali du 21 octobre 2026 : risque accepté pour l'usage mono-utilisateur. À reprendre obligatoirement si l'app devient multi-utilisateur ou distribuée à des tiers.

A9 n'est plus bloquant avant un changement de schéma ni pour la 1.0 en usage personnel. Il redevient bloquant si et seulement si l'app sort de l'usage personnel d'Ali ; sa vérification est alors obligatoire avant toute distribution à des tiers ou utilisation multi-utilisateur. Ce statut est un trou assumé, pas une story reportée ni un essai réussi.

Cette décision remplace les exigences A9 antérieures conservées ci-dessous pour historique. Aucun banc isolé ni séance A9 à lancer. Les preuves automatiques existantes sont conservées, sans les assimiler à un essai d'appareil. A6b reste « vérifié en usage après la 1.0 » : vérification future, non faite et non bloquante. Les autres essais natifs restent ouverts ; REL-01 à REL-03 ne sont pas clos sans leurs résultats.


## Historique annulé : préparation de la séance A9

Relire AGENTS.md et CLAUDE.md après compaction. Main 2398e8e2, #80 fusionnée après 48 CI verts de d67692ae ; preuves : 13 tests ciblés et 4 Rust, bundle main 58/58. Deux IPA A9 vérifiées ; paquet et guide transmis, A9 physique non exécuté, livraison 1.0 bloquée jusqu'à sa preuve. Branche active rel-03-a9-seance, worktree n-ios-apercus, consignation des artefacts en cours de PR/CI. Les branches instrumentées i-06-a9-build-afterapply (1226f203) et i-06-a9-build-interruption (2560945a) ne doivent jamais être fusionnées. Deux compilations seulement : 39637333456 / 39637672577, toutes deux réussies ; aucune compilation à relancer pour des docs.

Brouillon de remise : https://github.com/doncivo/circletasks/releases/tag/untagged-df3538464857e88980dc ; ne pas publier. ZIP SHA-256 e8b7d51a8d129a9b4e203ff047daca4bb51d403e155ef7c138cd8aa3db9d880a ; quatre IPA et deux guides contrôlés. Original 0.3.3 et candidat 1.0.0 vérifiés contre leurs assets publiés. Premier essai : exception et vraie restauration Rust, puis relance suspendue par le banc ; installer 0.3.3 par-dessus pour vérifier le schéma 18. Ensuite build interruption, attendre le diagnostic afterApply, tuer le processus depuis le sélecteur iOS, rouvrir ; vérifier reprise et données. L'ancien 0.3.3 doit refuser le schéma 19 ; le candidat correct 1.0.0 rend l'accès. Ne jamais désinstaller.

PC 1.0.0 publié, signature et endpoint vérifiés ; Ali utilise seulement sa bannière. A6b différé en usage après la 1.0 sans bloquer, jamais fait. Les autres essais natifs du guide restent ouverts ; pas de clôture REL-01/REL-02/REL-03 avant les retours réels. Les paragraphes suivants sont historiques et ne rouvrent aucune décision. L'ancienne branche rel-03-publication-1-0 (8200cf48) conserve des notes dépassées ; leurs faits utiles ont été repris, ne pas fusionner ses anciennes consignes de séance sans relecture. Aucun worktree supprimé, racine personnelle sale conservée.

## Priorité — IPA publiée, terminer recette automatique et audit

Actualisation : **#78 fusionnée dans c5fc22ee**, tête 241daa87, **48 CI verts**, runs **39607713371 / 39607884918**. Bundle main après fusion **58/58, 338 476 normalisés, 338 433 bruts, marge 19 924**, sources applicatives et dépendances identiques à ios-v1.0.0. Audit non publié **rel-02-audit-final**, worktree rel-02-audit, rebasé sans conflit sur ce main ; tête avant cette actualisation 280d1e07. Dossier d'audit, guide et statuts actuels relus, J02 indiqué intégré, lint/typage/revue verts, bundle local identique. Prochain : mesure avant push final, secrets, PR documentaire, attendre tous les CI, fusion et mesure main. IPA déjà publiée et vérifiée, aucun second build iPhone. Les paragraphes suivants conservent l'historique préparatoire ; appareil et signature/publication PC restent ouverts.

Après chaque compaction relire AGENTS.md, CLAUDE.md et ce point. Main **dcde7edc**, #76 fusionnée après **48 CI verts** de **85e58090**, runs **39602493222 / 39602483876** ; arbre main égal à l'arbre testé **785f0faf6b9d2330f529326c70794308b676eab7**. Bundle main **58/58, 338 476 normalisés, 338 433 bruts, marge 19 924**. Guide complet montré avant compilation et fusionné #75 ; #77 Vite 8.3.3 fusionnée, rouge 72154cc0 puis audit zéro avis, aucune transitive modifiée.

**Un seul build iPhone lancé**, par tag **ios-v1.0.0** sur dcde7edc, sans dispatch supplémentaire : **39605174348**, ios et publish verts. IPA **1.0.0/build 1.0.0**, identifiant fr.circletasks.planner, minimum 18.0, **7 356 430 octets**, SHA-256 **d993e7ed6f86c0ad0f7b8ec80cc8407b0ef0e31639aa66fb8a68ffed1de80057**. Téléchargement, asset, source.json et Info.plist XML exporté concordent ; contrat cinq plugins et check-source verts. Les deux avertissements de métadonnées de l'ancienne 0.1.0 sont historiques et l'entrée est conservée. IPA et lien du guide transmis à Ali en commentaire. N est l'IPA installée, ne jamais désinstaller ; vérification de sauvegarde iCloud avant N+1. A6 à deux jours et A9 natif restent ouverts.

**REL-01 PR #78**, branche/worktree **rel-01-1-0**, tête publiée **241daa87** : J02 composé **2/2 verts en 42 s** sur les dépendances finales, un worker, zéro retries, budget 40 s par test inchangé ; lint/typage, revue et bundle 58/58 verts. Guide contient maintenant version, lien, taille et empreinte réelles, matrice des douze parcours sans rejeu manuel inutile. Attendre 48 CI sur cette tête, fusion normale puis mesure main ; aucun nouveau build iPhone pour des tests/docs. Le premier commit propre de recette remappé est 27205581 ; aucun code applicatif modifié.

Préparation **REL-02** dans worktree **rel-02-audit**, branche **rel-02-audit-final**, non publiée, empilée sur origin/rel-01-1-0. Audit `docs/audits/2026-10-21-lot-1.0.md`, dernier commit avant ce point **c19d1a5f**, preuves réelles et limites relues ; npm frais zéro avis, hash des dépendances hors racine **bf2139e7180bf511acfb4cd1f9357dc7768caf031955f972f654ae74538df7af**. Après #78 : rebase de cette branche non publiée sur origin/main, actualiser les preuves de CI J02, revue, bundle avant push, secrets, PR/CI/fusion/mesure main. Ne pas réécrire les branches publiées.

REL-03 : IPA publiée, mais version/signature/publication PC et verdict de recette ouverts. Mise à jour PC uniquement par bannière ; jamais d'installeur manuel. Poursuivre tout travail indépendant autorisé, sans s'arrêter pour un compte rendu ; seuls les quatre cas d'arrêt d'Ali s'appliquent. Les essais réels iPhone sont encore nécessaires. Aucun worktree supprimé, aucune donnée personnelle lue. Racine passation-codex sale personnelle à préserver.

Vérifications locales d'artefact dans `.claude/worktrees/codex-main-validation/.codex-tmp/node_modules/runtime/ios-1.0.0-run39605174348/` (IPA et info/Info.plist) et `source-published-1.0.0.json`. Python absent : aucun installateur lancé ; utiliser les scripts existants `scripts/ios/plist.mjs`, `check-source.mjs`, `check-plist-contract.mjs`. Pas de lecture des données personnelles. Aucun processus local de test/build encore actif lors de ce point.

## Priorité — guide intégré, unique IPA à compiler et publier

Actualisation après la reprise : **#77 fusionnée dans f9d7d242**, tête 636a6a64, 48 CI verts. Candidate #76 remise sur ce main, tête de fusion locale **d86507e4** (non poussée), `npm ci --ignore-scripts` terminé, Vite 8.3.3 et audit zéro avis ; revue finale de préparation consignée dans REL-03, contrat version vert. Mesures main #77 et candidate finale en cours. Prochain : consigner mesures, secrets, push normal de #76, attendre les 48 CI de la nouvelle tête, fusion et mesure main ; une seule compilation/publication iOS ensuite. REL-01 locale actualisée sans toucher au guide : **b9d0e7db**, non publiée. Les paragraphes suivants conservent l'historique préparatoire.

Après compaction relire AGENTS.md, CLAUDE.md et ce point. Guide complet montré à Ali avant compilation, puis fusionné #75 dans **865c8729** après 48 CI verts. Sauvegarde locale/iCloud distinguée, SideStore détaillé, cinq régressions en tête, matrice REL-01 sans rejeu inutile ; A6 à deux jours différé et A9 natif ouvert. Bundle main #75 **58/58, 338 479 normalisés, 338 411 bruts, marge 19 921**. #74 également fusionnée (454778a9), compilation Swift et appareil ouverts.

Nouvel audit npm frais : Vite 8.3.2 affecté, preuve rouge **72154cc0**, patch exact 8.3.3 sans transitive changée, audit zéro avis, lint/typage/revue et bundle verts. Branche **rel-02-vite-audit**, worktree rel-02-audit, PR **#77**, tête après intégration du guide **636a6a64** ; attendre la CI complète sur cette tête, fusion puis mesure main. Ne pas reprendre les 48 verts de la tête précédente comme preuve de la tête de fusion.

Branche publiée **rel-03-lot-ios**, worktree **n-ios-apercus**, PR **#76** : version candidate 1.0.0 dans les cinq fichiers racines, notes extraites, 75 tests release/SideStore, lint/typage/revue verts, bundle préparatoire 338 476 normalisés marge 19 924. Les 48 CI verts de b58d0df sont historiques ; fusion locale du guide **9d3a9412** non poussée, docs seulement. Après #77, fusionner main dans cette branche publiée, préserver les historiques documentaires, installer les dépendances exactes du lock (Vite 8.3.3), mesurer le bundle, secrets, push normal, attendre la CI, fusion et mesure main. Puis **une seule compilation iOS et publication** sur le tag ios-v1.0.0 inexistant au contrôle ; jamais push du tag plus dispatch qui ferait deux builds. Workflow existant accepte les deux voies. Identifiant fr.circletasks.planner inchangé. Environnement releases : aucune approbation humaine, règles autorisent ios-v*, secret RELEASES_TOKEN présent (noms seulement consultés). Aucun tag ni build iOS encore lancé.

REL-01 préparée dans rel-01-1-0, tête locale **36276d76** après replay du seul commit propre sur main #74 ; J02 2/2 vert local, J10/J11 2/2 verts, lint/typage/revue verts. Ne pas écraser le guide récent avec cette branche ancienne. Continuer les préparations autonomes ; preuves natives, REL-01/REL-02 et livraison REL-03 restent ouverts jusqu'aux vérifications réelles. Ali a dit « reprendre » : poursuivre, pas de nouvel arbitrage. Aucun worktree supprimé et aucune donnée personnelle hors dépôt consultée.

## Priorité — guide montré avant compilation

#74 fusionnée, main 454778a9, tête ad28cd48 avec 48 contrôles verts et revue consignée. Branche active n-ios-chk-01 dans le worktree ci-sec-01-audit-20261021 : guide de séance montré à Ali, sauvegarde locale/iCloud distinguée, SideStore détaillé, matrice REL-01 sans rejeu inutile. Protocole physique non exécuté. Finir lint/typage, bundle, secrets, PR/CI/fusion et mesure main. Puis préparer version et notes de l'IPA unique, compiler et publier sans redemander. A6 à deux jours et A9 natif restent ouverts. REL-01 préparée dans rel-01-1-0, commit 96a034d9 à rejouer seul sur main selon l'instruction ci-dessous. Aucun build iPhone encore lancé.

## Point prioritaire du 2026-10-21 — B5 fusionné, N-IOS-FIX-01 en publication

Après chaque compaction, relire AGENTS.md, CLAUDE.md et ce point ; il prévaut sur les historiques. Main **1eac03fd**, #72 fusionnée après les 48 CI verts de la tête **2b4315a7**, runs **39556430486 / 39556432201**, revue approuvée ; bundle main **58/58, 338 458 normalisés, 338 392 bruts, marge 19 942**. B5 code corrigé sur les seuls chemins prouvés, physique 18 ouvert ; suspects non prouvés inventoriés après 1.0. TLS #73 également fusionnée et auditée (9baff642, f1eb69f4, 48 CI verts) ; signature réelle de livraison encore ouverte.

Travail actif : branche existante **n-ios-apercus**, worktree du même nom. Rebase final sur main B5 sans conflit de code, tête de rebase 77dbc2df ; rouge courant **05e70a80**, correctif **8b25ac25**, blobs identiques aux preuves exécutées (ancien rouge 0e23aa2e, ancien correctif 2393eec6). **345 tests / 24 fichiers**, lint global, typage et revue du diff verts ; code et tests identiques après les rebases. 19 tests de frontière et 9 Rust historiques, à nouveau en CI sur la tête publiée. Commit de consignation **dd03f6fd**. Bundle final en cours, puis secrets, push/PR, attendre 48 verts, fusion et mesure main. Le .codex-tmp non suivi ancien est conservé ; aucun temporaire à commiter. Swift et appareil restent ouverts pour l'IPA unique.

Préparation indépendante REL-01 : branche/worktree **rel-01-1-0**, tête **96a034d9**, base **19cd9262** (ancienne tête N-IOS-FIX-01). J02 composé PC → synchro → plan iPhone → action Fait → PC : **2/2 verts**, 35,9 s, zéro retries, un worker ; J10/J11 **2/2 verts** dans le projet PC, deux filtres iPhone préexistants inchangés. Lint, typage et revue verts ; aucun code applicatif modifié. Fiche et README rectifiés, recette finale et appareil non clos. Après fusion N-IOS, utiliser **git rebase --onto origin/main 19cd9262 rel-01-1-0** pour rejouer seulement ses propres commits, sans les anciennes preuves N-IOS déjà fusionnées. Ne pas publier avant les étapes précédentes. Cache Playwright dans t-tech-01/node_modules/.cache/codex-t-tech-validation/browsers ; TEMP/TMP/npm-cache dans le worktree, CT_E2E_PORT_BASE 47100 ; pas de test lourd pendant un build local.

Suite : annexes (fiche N-IOS-CHK-01 à écrire), guide ordonné existant à compléter des douze parcours sans déplacer les cinq régressions en tête ; version de candidate, un seul lot iPhone Actions et publication IPA ; REL-01, REL-02, REL-03. Aucun build iPhone ni suppression de worktree pendant cette reprise ; preuves physiques toujours ouvertes, dont I-06 A1 à A10.

## Point prioritaire du 2026-10-21 — TLS fusionné, B5 remis sur main

Relire AGENTS.md, CLAUDE.md et ce point après compaction ; il prévaut sur les historiques. #73 fusionnée dans main 9baff642, tête f1eb69f4, runs 39554560617 / 39554565334, 48 CI verts dont les deux audits TLS. Rust local, lint, typage et revue verts ; mesure du bundle sur main 58/58, 338 443 normalisés, 338 387 bruts, marge 19 957. Signature réelle de livraison encore ouverte.

Travail actif B5 : branche publiée y-ios-02-fix-01-partiel, worktree rel-02-audit. Fusion de origin/main résolue, conflits documentaires seulement, historiques des deux côtés conservés ; aucun rebase ni force-push. Les 44 contrôles hors audit/agrégat de la précédente CI B5 sont verts, mais une nouvelle CI complète est exigée sur la fusion. Terminer consignation, bundle, secrets, push, attendre 48 verts, fusion #72, mesure main. Rouge 016dbd04, 86eeadc0 et 9dba2a9e ; correctif f987edef, tête initiale 5c845e67 ; 5 h approuvées, suspects non prouvés reportés sans correction.

N-IOS-FIX-01 : n-ios-apercus, tête 19cd9262 (base B5 5c845e67), non publiée ; 345 tests du module, lint global, typage verts, preuves de blobs rouge/vert conservées. Rebaser sur main après fusion B5, actualiser aliases, revue/bundle/PR/CI/fusion puis mesure main. Préparation indépendante REL-01 dans rel-01-1-0, base 19cd9262 : fiche PO et test J02 composé (PC → synchro → rappel iPhone → Fait → PC), pas encore exécuté ni commité. Helper sync reçoit un callback facultatif avant ouverture pour initialiser les faux et horloges ; aucun code applicatif modifié. Dépendances locales copiées, pas de jonction. Lancer ce test seulement après les builds lourds, avec cache navigateur et TEMP dans le dépôt, deux projets, un worker, zéro retries. Aucun nouveau défaut applicatif affirmé.

Suite : annexes dont fiche N-IOS-CHK-01 à écrire avant appareil, version de candidate, unique IPA Actions et publication, REL-01 à REL-03. Le guide ordonné est présent ; ajouter les douze parcours fonctionnels après les régressions déjà en tête. Les vérifications iPhone et I-06 restent ouvertes. Aucun worktree supprimé.

## Point prioritaire du 2026-10-21 — audit TLS avant B5

Après compaction relire AGENTS.md, CLAUDE.md et ce point. Travail actif : branche/worktree ci-sec-01-audit-20261021 depuis main dc14badf. La CI de B5 #72 (tête 5c845e67) est rouge sur deux nouveaux avis TLS, RUSTSEC-2026-0382 / 0383, runs 39552278950 / 39552285403. Complément CI-SEC-01 : mises à jour minimales Cargo.lock vers rustls-webpki 0.103.16 et webpki-root-certs 1.0.10, sans nouvelle exception ; 1 h active, alerte 1,5 h. Attendre audit, tests, lint/typage, revue, bundle avant push, CI complète, fusion et mesure main. Puis fusionner main dans la branche B5 publiée (jamais rebase/force-push), attendre CI et fusionner B5, mesurer main.

B5 : 5 h approuvées comme périmètre réel ; preuves rouges 016dbd04, 86eeadc0, 9dba2a9e ; correctif f987edef. 49 ciblés, cycle complet renforcé 1/1, 41 contrats, 72 hostiles verts ; lint, typage, revue consignés. QA élargie 2251 verts / 8 échecs résolus par renforcement des anciens oracles et suppression de concurrence locale avec le build ; scénario de restauration inchangé 8/8 seul, pas de timeout augmenté ni retry automatique. Inventaire des suspects non prouvés et report après 1.0 dans la branche B5. Bundle B5 338 458 normalisés, marge 19 942 ; dernier main 338 413, marge 19 987.

N-IOS-FIX-01 : branche existante n-ios-apercus rebasée sur B5, tête 19cd9262, non publiée. Rouge 56a5aa37 et correctif 39ec8856 : blobs identiques aux preuves antérieures ; 345 tests / 24 fichiers verts après rebase. Finir lint/typage/revue/bundle/CI après mise à jour sur le main B5. Puis annexes, guide ordonné docs/essais-iphone.md déjà présent, unique build iPhone et publication IPA, REL-01 à REL-03. Aucun build iPhone ni suppression de worktree pendant cette reprise ; preuves physiques toujours ouvertes. Pas de nouvelle décision requise.

## Point prioritaire — reprise du 2026-10-21, B5 en QA

Après chaque compaction : relire AGENTS.md, CLAUDE.md et ce point. Ali approuve 5 h comme périmètre réel, sans dérive, et demande de continuer jusqu'à REL-03 ; seuls les quatre cas d'arrêt convenus s'appliquent. Chemin corrigé = rouge propre préalable ; suspect non prouvé = inventaire avec limite, après 1.0, aucun correctif aveugle.

Branche active **`y-ios-02-fix-01-partiel`**, worktree `.claude/worktrees/rel-02-audit`. **`86eeadc0` poussé** après bundle 58/58 et scan secrets 0 candidat. Nouveaux rouges dédiés **`9dba2a9e`**, correctif **`f987edef`** : reçus de suppression, entretien orphelin, oubli partiel, reprise par tranches, lecture Apple interrompue et deux réparations de listes. **49/49 ciblés**, scénario de cycle complet renforcé **1/1**, lint global et typage verts. Test explicite : cause conservée après cycle partiel et redémarrage puis effacée après suppression réelle et scan de confirmation. Revue distincte du code approuvée dans la fiche, aucune clôture avant CI complète.

QA élargie terminée : **2251 verts / 8 échecs**, 206 fichiers. Six anciens oracles de résolution immédiate sont renforcés pour attendre l'absence confirmée ; **41/41** tests de contrat et **72/72** du banc hostile verts. Deux timeouts de restauration (5000 ms) pendant concurrence avec le build bundle : orchestration locale corrigée, fichier inchangé exécuté seul, **8/8 en 11,34 s**, même délai. Lint global, typage et revue du code verts ; bundle du correctif **58/58**. Les résultats composés ne sont pas revendiqués comme une suite complète locale verte : celle-ci reste obligatoire en CI. Logs dans `.codex-tmp/`. Aucun timeout augmenté, skip ni relance automatique. Aucun changement de Focus, requestAccess, acquittements ou autres suspects non prouvés. Prochaines actions : contrôles finaux, push/PR, attendre tous les CI verts, fusion `--merge`, mesure main, puis N-IOS-FIX-01.

Main **`dc14badf`**, #71 fusionnée ; mesure main 338 413 normalisés / 338 339 bruts, marge 19 987. Après B5 : rebase et validation de la branche existante **`n-ios-apercus`** (préparation `c068df93`, non publiée ; `.codex-tmp/` non suivi à conserver), annexes, IPA unique via Actions, REL-01 à REL-03. Critères physiques ouverts : B5 18, clavier, UIKit, aperçus, `%`, I-06 A1 à A10. Aucun nouveau build iPhone ni nettoyage de worktree.

## Historique — inventaire B5 et arrêt sur estimation

Relire AGENTS.md, CLAUDE.md et ce point après chaque compaction. Ali a levé l'arrêt sur le défaut B5 et demandé l'inventaire des effacements persistés avant correction. Travail actif : branche `y-ios-02-fix-01-partiel`, worktree `.claude/worktrees/rel-02-audit`. Rouge original `016dbd04` conservé, copie `b441548a` ; aucun correctif de production appliqué.

**Nouvel arrêt, cas 3 : estimation de 2 h à 5 h actives (+150 %), alerte initiale à 3 h.** Voir `docs/audits/2026-10-20-effacement-erreurs.md` : chemins prématurés, résolutions relues, points restant à prouver et acquittements explicites. Deux rouges supplémentaires exécutés, 2 rouges / 18 verts, couverture coupée : cause effacée après lot partiel et `store-unavailable` effacé après réparation de réglage Apple. Après information d'Ali : preuves des autres chemins, correction commune B5 sans nouvelle story, QA module, lint/typage, revue, bundle avant push, CI complète avec couverture, fusion et mesure main.

#71 fusionnée après 48 CI verts : main **`dc14badf`**. Bundle **58/58, 338 413 normalisés, 338 339 bruts, marge 19 987**. UIKit physique encore ouvert. Ensuite N-IOS-FIX-01 sur `n-ios-apercus` (préparation `c068df93`, non publiée), annexes, IPA unique, REL-01 à REL-03. Aucun nouveau build iPhone ni suppression de worktree ; aucune donnée personnelle hors dépôt consultée. Les mentions historiques d'arrêt cas 2 ci-dessous sont dépassées par ce point.

## Point d'arrêt historique du 2026-10-20

Après chaque compaction, relire AGENTS.md, CLAUDE.md et ce point de reprise dans le worktree actif avant de travailler. Le checkout racine `passation-codex` est ancien et contient des modifications personnelles à conserver.

**Arrêt demandé par la règle d'Ali, cas 2 : état faux confirmé.** Audit préparatoire sur branche `rel-02-audit`, worktree `.claude/worktrees/rel-02-audit`. Preuve rouge **`016dbd04`**, `tests/unit/sync/hostile/mixedOldEpochDeletion.test.ts` : refus `io`, puis suppression partielle d'une ancienne époque ; un substitut reste, mais l'interface dit **« À jour · à l'instant »**, sans cause persistée. Test ciblé rouge, lint vert, aucune correction fonctionnelle. Complément de **B5 / Y-IOS-02-FIX-01**, sans nouvelle story (décision déjà prise pour les substituts). Voir sa fiche, l'audit et le journal. Ne pas lancer de compilation iPhone ou déclarer le lot livré pendant cet arrêt.

Main **`44441dbe`** : #65 B5 initiale, #66 Y-IOS-07, #67 N-TECH-02, #68 N-FIX-02, #69 CI-SEC-01, #70 C-FIX-01 fusionnées. Dernière mesure après #70 : **58/58, 338 443 normalisés, 338 387 bruts, marge 19 957**. #70 tête `6f2a66be`, runs 39468511359 / 39468517620, 48 contrôles verts ; clavier physique ouvert. Les preuves B5 initiales sont historiques et n'incluent pas le nouveau cas partiel.

**Y-IOS-06 #71**, branche `y-ios-06`, tête **`004d45a1`** : les trois rouges demandés sont verts, puis **371 tests Rust sync verts**, lint, typage, revue et **48 CI verts**. Rouge initial publié `546bee4e`, correctif `f535596f`, blobs identiques aux preuves avant rebase. Le contrat voisin sync_ios_y02 a été adapté à la garde factorisée après un rouge CI ; aucune assertion Annuler ou premier plan supprimée. PR non fusionnée à cause de l'arrêt global. Sa branche contient la règle de relecture après compaction et le guide `docs/essais-iphone.md` réécrit avec les cinq cas déjà cassés en tête, annexes et I-06 A1 à A10. UIKit reste à vérifier avec l'unique lot iPhone.

**N-IOS-FIX-01**, branche existante `n-ios-apercus`, tête préparatoire **`c068df93`**, non publiée : texte facultatif d'aperçu masqué, aide iPhone, catalogues propres hors départ. 344 tests du module, 19 adaptateur, 9 Rust, lint, typage et revue verts ; 35 contrôles ciblés verts après rebase intermédiaire. Budget préparatoire **338 464**, marge **19 936**, coût 21 octets. Rebase sur main après #71, mesure finale, PR/CI/fusion encore requis. Identifiants de preuve à remapper au rebase final ; les anciens restent consignés dans la fiche.

Suite après traitement du cas d'arrêt : terminer B5, #71 puis N-IOS-FIX-01 ; guide et unique IPA ; REL-01, REL-02, REL-03. `%`, clavier, gardes, aperçus, B5 et I-06 ont des preuves physiques ouvertes. REL-02 est seulement préparée (npm 0 avis, exception RSA documentée non compilée, pas de conformité finale). Aucun worktree supplémentaire supprimé ; données personnelles hors dépôt jamais consultées.

Écrit à la passation de Claude Code vers Codex (décision d'Ali du 2026-10-19). Règles de travail : `AGENTS.md`. Plan de la 1.0 : `docs/backlog.md` section « Palier 1.0 », audit `docs/audit-1.0.md`, décisions `docs/decisions.md`.

## Suivi du 2026-10-20 — à lire avant l'historique

Après chaque compaction, relire `AGENTS.md`, `CLAUDE.md` et ce fichier avant de travailler (règle d'Ali du 2026-10-20). Le checkout racine `passation-codex` peut être ancien : lire aussi les documents du worktree de validation de main à jour et conserver les modifications personnelles du checkout racine.

Main vérifié : `44441dbe`, après **#65 B5**, **#66 Y-IOS-07**, **#67 N-TECH-02**, **#68 N-FIX-02**, **#69 CI-SEC-01**, **#70 C-FIX-01**. Chaque fusion a attendu sa CI complète et sa revue consignée ; bundle remesuré sur main à chaque fois. Dernière mesure : **58/58, 338 443 octets normalisés, marge 19 957**, plafond 358 400 inchangé. Le chargement différé des rappels a rendu environ 5 Ko de marge. B5 conserve son critère physique 18 ouvert.

**C-FIX-01 #70** : code fusionné dans 44441dbe, tête 6f2a66be, runs 39468511359 / 39468517620, 48 CI verts avec couverture, lint/typage et revue approuvés. Bundle main 58/58, 338 443 normalisés, marge 19 957. Critère physique 6 ouvert : vrai clavier à vérifier sur l’IPA.

**Y-IOS-06** : les trois tests de source rouges demandés par Ali sont devenus verts ; **40/40 tests ciblés puis 371 tests Rust du module sync verts**, lint, typage et revue approuvés. PR #71 publiée après C-FIX-01 ; contrat historique sync_ios_y02 adapté à la factorisation après le run rouge 39470831050. Nouvelle CI complète requise avant fusion. Les gardes natives et le délégué à réponse unique ne sont pas encore vérifiés par exécution de UIKit. `docs/essais-iphone.md` a été réécrit : cinq cas déjà cassés en tête, puis annexes et I-06 A1 à A10, chaque ligne avec action et résultat attendu. A9 reste explicitement ouvert sans son protocole appareil.

**N-IOS-FIX-01** : branche existante `n-ios-apercus` conservée, tête préparatoire `46f5af1f`, non publiée. Texte de remplacement facultatif, aide iPhone et catalogues propres hors du départ ; rouge de frontière `1ed328c3`, correctif `e3cbfa4c`, 344 tests du module + 19 adaptateur + 9 Rust, lint, typage et revue verts. Budget préparatoire **338 464**, marge **19 936**, coût 21 octets. Rebase après Y-IOS-06, mesure finale, PR/CI et fusion encore requis. Le cache local incomplet du vieux worktree a été complété avant sa mesure verte.

Suite inchangée : terminer ces fusions ; vérifier le guide puis une seule compilation iPhone du lot et publication de l'IPA ; REL-01, REL-02, REL-03. Les preuves physiques B5, clavier, sélecteur, aperçus, `%` et I-06 restent ouvertes. Ne s'arrêter que pour les quatre cas convenus, pas pour un compte rendu ; deux lignes par story terminée et enchaînement. Aucun worktree supplémentaire supprimé pendant ce suivi ; les fichiers personnels hors dépôt restent intouchables.

## Mise à jour de reprise du 2026-10-19 — quatre PR fusionnées

**État courant au 2026-10-20** : B5 / Y-IOS-02-FIX-01 fusionnée par #65 (`095c5e4a`, critère physique 18 encore ouvert), B16 / Y-IOS-07 fusionnée par #66 (`51c6eb07`), chacune après revue et CI complète verte. Dernier bundle sur main : **343 463 / 358 400 octets**, marge **14 937**. Travail actif : branche et worktree `n-tech-02`, preuves rouges `6246cc6b` et `1be2b700`, correctif de la fenêtre de sept jours en validation. Levier isolé du planificateur à la demande : **338 381 octets**, gain **5 082** avant gestion d'échec définitive. N-FIX-02 vient ensuite, puis sécurité de signature, clavier, sélecteur, branche existante des aperçus, IPA unique et REL-01 à REL-03. Aucun nouvel essai physique ni nouvelle IPA revendiqués. Les listes historiques ci-dessous ne remplacent pas cet état.

La décision d'Ali remplace l'ordre initial ci-dessous : **#62 → #60 → #61 → #63**. Les quatre sont fusionnées après QA, revue consignée et CI complète verte avec couverture : #62 (`c76bc718`), #60 (`1838dbe5`), #61 (`772d0f29`), #63 (`66bf7786`, tête `2bfca264`). Le bundle a été vérifié sur `main` après #62 et #60 (27/27), puis #61 (47/47, **340 810 octets normalisés**, marge **17 590**), puis #63 (**51/51, 340 260 octets normalisés**, brut 340 188, marge **18 140**). R1 est corrigé ; CI finale de #63 : runs **39262885779 et 39262896766**, tous les contrôles verts. Le défaut de réactivité apparu en CI a aussi été corrigé avant fusion (`d947b186`) ; les deux jobs de performance sont verts sur le correctif. Les preuves rouges historiques restent dans les fiches.

Protection classique de `main` : le nombre d'approbations GitHub était déjà zéro ; le PATCH à zéro l'a confirmé. PR, branche à jour et statut obligatoire « suite verte » conservés. La revue distincte reste obligatoire et son approbation est consignée dans la fiche de story : GitHub interdit l'auto-approbation. Règle inscrite dans `AGENTS.md`.

Nettoyage autorisé : inventaire présenté avant suppression, puis **66 worktrees fusionnés et propres supprimés**, avec recontrôle de propreté et d'ascendance juste avant chaque suppression ; aucune branche supprimée. Tous les autres worktrees conservés. `.bt.sh` est un ancien lanceur local de mesure de bundle ; `.bt/` contient son cache Node (189 fichiers, 2 880 908 octets). Ils restent conservés en attendant la décision d'Ali.

Les sections suivantes décrivent le point de départ historique ; leurs PR ouvertes et leur ordre initial ne décrivent plus l'état courant. I-06 reste « code fusionné, en attente de vérification appareil » jusqu'au succès de A1 à A10.

## Reprise du 2026-10-20

Mise à jour du **2026-10-20** : Y-IOS-02-FIX-01 étendue (B5 et défauts 2/3 du banc) est fusionnée par **#65**, `main` **`095c5e4a`**. Tête `1b908513`, runs CI `39277457609` et `39277480003`, 48 contrôles verts avec couverture ; revue dans la fiche. Bundle sur `main` : 55/55, **342 924 octets normalisés**, 342 871 bruts, marge 15 476. Essai physique encore requis avant « fait ».

Travail actif : branche et worktree **`y-ios-07`**, depuis ce `main`. Analyse préalable consignée avant code (`6da1939f`), scénario historique rouge `ad3ae641`, run CI rouge `39386547885`. Correctif relu **`43d2d299`** : rotation locale, cible et échec persistés, reprise après arrêt, bornes et panne du bloc de lecture couvertes. QA du module : **2 331 tests sur 196 fichiers**, puis **81 ciblés après revue**, **368 Rust**, e2e iPhone simulé **1/1**. Revue approuvée dans la fiche ; lint et typage verts, bundle 56/56 (**343 463 normalisés**, 343 425 bruts, marge 14 937). CI complète encore requise avant fusion. Aucun nouveau lot IPA compilé. Continuer ensuite N-TECH-02, N-FIX-02, CI-SEC-01, C-FIX-01, Y-IOS-06, N-IOS-FIX-01 sur la branche existante, les essais annexes, le lot IPA puis REL-01 à REL-03, selon l'ordre d'Ali.

## 1. Point de départ historique

| Élément | Valeur |
| --- | --- |
| `main` | `5bd03d46` (PR #59 SEC-01), CI « suite verte » verte (run 39138955865) |
| Version en service | 0.3.3 PC et iPhone (tags `v0.3.3`, `ios-v0.3.3`) ; `package.json` 0.3.3 |
| Dépôt local | `C:\Dev\circletasks-kit`, sur la branche `passation-codex` (cette documentation, PR à fusionner) ; ~70 worktrees de branches déjà fusionnées sous `.claude/worktrees/` (voir section 7) |
| Appareils | PC `7d0b4a0a-…`, iPhone `ef50b6f7-…` ; ancien PC `56d4eec1-…` oublié le 2026-10-17 (ses sauvegardes du 16 octobre portent encore `is_self = 56d4…`) |
| Journaux | export iPhone dans `C:\Users\SPECTRE\iCloudDrive\CircleTasks\circletasks-logs-*.txt` ; données PC dans `%APPDATA%\fr.circletasks.planner\` (ne jamais y toucher) |

**Le backlog est en retard sur le code.** Lignes encore fausses dans `docs/backlog.md` : REL-TECH-01 « en cours » (fusionnée, PR #31), Y-10-FIX-01 « à faire » (fusionnée, PR #34), T-14-FIX-01 et T-14-FIX-02 « en revue » (fusionnées, PR #32 et #51), I-06 « en revue » (fusionnée, PR #23 ; vérifications A1 à A10 sur l'iPhone encore dues), Y-TECH-05, Y-FIX-04, Y-FIX-02, Y-IOS-05, SEC-01, UI-FIX-01 « fait sur la branche » (toutes fusionnées, voir section 2). Première tâche de documentation : réconcilier les statuts avec les PR et les preuves. Exception I-06 : code fusionné, en attente de vérification appareil ; clôture seulement après A1 à A10 passées (décision d’Ali du 2026-10-19). Un audit Codex du 2026-10-19 (lecture seule, non vérifié) a aussi relevé que A-07, N-03, K-05 à K-07, I-03 ont du code et des tests malgré un statut « à faire » : vérifier fiche par fiche avant de les reprendre.

## 2. Fusionné dans `main` (palier 1.0 et correctifs de séance)

| Bloquant | Story | PR | Date |
| --- | --- | --- | --- |
| B13 | Y-TECH-03 banc des faux iCloud hostiles | #44, clôture #45 | 2026-10-17 |
| B14 | Y-TECH-04 règle de report option B, identité conservée, choix éclairé de la sauvegarde | #48 | 2026-10-17 |
| B15 | REL-TECH-02 installeur sans piège (crochet NSIS) | #41, clôture #42 | 2026-10-17 |
| B4 | Y-FIX-04 plus de perte silencieuse au report d'époque | #49 | 2026-10-18 |
| (ajout 2) | Y-TECH-05 compte rendu visible du report d'époque | #52 | 2026-10-18 |
| B17 | T-14-FIX-02 roue des jours WebKit | #51 | 2026-10-18 |
| B2 | Y-FIX-02 impasse de première publication | #56 | 2026-10-18 |
| B6 | Y-IOS-05 appel iCloud muet | #54 | 2026-10-18 |
| B7 | SEC-01 plugin SQL fermé | #59 | 2026-10-18 |
| B11 | UI-FIX-01 thème sombre lisible | #57 | 2026-10-18 |
| B12 | PRD-01 exigence de taille de texte retirée du PRD | (docs, #43) | 2026-10-17 |
| — | REL-TECH-01 smoke du vrai binaire Windows | #31 (+ `b8a251a5` mesure des pixels en Node) | 2026-10-15 |
| — | Y-10-FIX-01, Y-IOS-02-FIX-02, T-14-FIX-01, I-06 | #34, #36/#39/#40, #32, #23 | 2026-10-09 → 10-17 |
| — | Fiches des étapes 4 à 6, décisions du 18 octobre, inventaire du bundle | #53, #58, #50 | 2026-10-18 |
| — | Test instable critère 11 (pilote SQLite Wasm), test instable restore_ios | #55, #47 | 2026-10-17/18 |

## 3. En CI ou en relecture (PR ouvertes)

| PR | Branche | Story | État au 2026-10-19 | Reste à faire avant fusion |
| --- | --- | --- | --- | --- |
| #60 | `y-fix-05-segment-tronque` | Y-FIX-05 (B18, segment tronqué jamais clos) | CI verte deux fois (runs 39139398906 et 39139403003), mergeable ; **aucune relecture** ; fiche `docs/stories/Y-FIX-05.md` « en attente de qa-test, revue et CI » | Passe qa-test puis code-reviewer, corrections, fiche « fait » (preuves rouge 89d5ef7d / vert 528bb5f2), audit B18 « corrigé », puis `gh pr merge 60 --merge` |
| #62 | `y-fix-03-lecture-en-echec` | Y-FIX-03 (B3, lecture en échec muette) | Fiche « fait sur la branche » (rouge a1964dee, vert d1baaf85) ; **poussée pour la première fois le 2026-10-19**, CI lancée | Attendre « suite verte », relecture code-reviewer, mesure du bundle, fusion. Touche `src/sync/engine.ts` : à fusionner avant d'ouvrir Y-IOS-02-FIX-01 et Y-IOS-07 |
| #63 | `t-tech-01-recurrences-synchro` | T-TECH-01 (B8, doublons de récurrences, report avant synchro) | 18 commits : développement, revue sur branche corrigée (B1, B2, I1 à I4, M1 à M6 ; M5 et M6 commités à la passation, tests du module verts) ; **poussée pour la première fois le 2026-10-19**, CI lancée ; ligne « Statut » de la fiche vide | Attendre « suite verte », `npm run test:bundle`, compléter la fiche (statut, preuves rouge/vert : 27a038d9, 49c6e943, c78a47d1, 9e11825e rouges ; c3d00efb, 5cf68143, d825bae6 verts), fusion. **À fusionner avant #61** |
| #61 | `bundle-01-paliers` | BUNDLE-01 (paliers 1 et 2, garde par liste blanche, mesure sans bruit de hachage) | 16 commits ; marge mesurée 17 674 octets ; docs commitées à la passation ; **poussée pour la première fois le 2026-10-19**, CI lancée ; pas de relecture | Attendre « suite verte », relecture code-reviewer, **rebase sur `main` après #63** (fichiers communs `src/App.tsx`, `src/features/app/lazyScreens.tsx`), fusion, puis ajouter la règle de la garde dans `CLAUDE.md` (déjà dans la branche) |

Ordre de fusion recommandé : #60, #62, #63, puis #61 rebasée. Après chaque fusion, relire `npm run test:bundle` sur `main`.

## 4. Reste à coder, dans l'ordre

Chaque story : branche propre, fiche lue en entier, test rouge avant, vert après, identifiants dans la fiche, estimation suivie (arrêt à +50 %).

1. **Y-IOS-02-FIX-01** (B5 réduit, étape 3) — `docs/stories/Y-IOS-02-FIX-01.md`. Échec de suppression de l'époque orpheline et `delete-own-failed` mémorisés dans `sync_meta`, visibles dans Détails et en bandeau A-09, « Réessayer maintenant » ; plus les défauts 2 et 3 du banc (instantanés qui reviennent après une suppression acceptée non propagée ; substitut persistant réarmé à chaque cycle). Scénario 4 du banc sur `y-tech-03-scenarios-rouges` (`c41d5d66`, `tests/unit/sync/hostile/scenario4DurableDelete.test.ts`). Dépend de : Y-IOS-02-FIX-02 (fait), #62 fusionnée (même `engine.ts`). Une session Codex lancée le 2026-10-19 sur cette story a été arrêtée pendant l'analyse : rien n'a été écrit.
2. **Y-IOS-07** (B16, étape 3) — `docs/stories/Y-IOS-07.md`. Segment de tête évincé par iOS : sur `cloud-pending` à l'ajout, ouvrir le segment `max + 1` (une rotation par cycle, échec visible). **Avant le code** : réponse écrite à la section « Raison technique de faire l'inverse ? » ; s'il existe une raison, arrêt et alerte à Ali. Scénario 6 sur `y-tech-03-scenarios-rouges` (`scenario6EvictedHeadSegment.test.ts`). Touche `publisher.ts` et `src-tauri/src/sync/store.rs`. Avenant ADR 0011 au prochain § libre (§33 est pris par Y-FIX-05 : vérifier).
3. **N-TECH-02** (B9, étape 6) — `docs/stories/N-TECH-02.md`, 24 critères. Puis **N-FIX-02** (B10) — `docs/stories/N-FIX-02.md`, 27 critères. Même dossier `src/features/reminders` et même budget de départ : jamais en parallèle, N-TECH-02 d'abord. Levier de bundle à mesurer avant : `replanNotifications` par `import()`.
4. **Points restants du palier** (fiches à écrire, `docs/backlog.md` lignes N-IOS-CHK-01, CI-SEC-01, C-FIX-01, Y-IOS-06) : CI-SEC-01 clé de signature hors du build front (3 h) ; C-FIX-01 clavier de la checklist iPhone et Y-IOS-06 gardes du sélecteur iOS (5 h ensemble) ; N-IOS-CHK-01 est un essai d'Ali (`%` sur l'appareil), pas du code.
5. **N-IOS-FIX-01** (séance 0.3.2) — branche `n-ios-apercus` (`df8ab316`, un commit du 2026-10-16, fiche `docs/stories/N-IOS-FIX-01.md` sur la branche) : texte de remplacement des aperçus masqués iOS. À rebaser sur `main`, CI, relecture, PR.
6. **Compilation iPhone du lot** (`build-ios.yml`, une seule), puis **essais d'Ali** (`docs/essais-iphone.md`) et test de mise à jour SideStore avec deux IPA successives N puis N+1 (I-06, vérifications A1 à A10 ; N+1 publiée seulement quand N est installée).
7. **Livraison** : REL-01 (12 parcours clés PC et iPhone), REL-02 (audits sécurité, performance, accessibilité), REL-03 (tag `v1.0.0` et `ios-v1.0.0`, guides `docs/install-pc.md` et `docs/install-iphone.md`, `CHANGELOG.md`).

Stories de l'ordre 5 encore « à faire » au backlog, hors palier 1.0 (à trier après la 1.0 sauf décision d'Ali) : A-07, N-03, K-05, K-06, K-07, K-TECH-01, Q-05, I-02, I-03, I-05, CAP-IOS-01, N-TECH-01 (critère 12 remplacé par N-TECH-02).

Dépendances entre dossiers : `src/sync` (Y-IOS-02-FIX-01, Y-IOS-07, #62) en séquence, jamais en parallèle ; `src/features/reminders` (N-TECH-02, N-FIX-02) en séquence ; `src/App.tsx` et `lazyScreens.tsx` (#63, #61) en séquence ; `src/db` et `src/domain` jamais à deux lots en parallèle.

## 5. Décisions d'Ali déjà prises, à ne pas rouvrir

Sources : `docs/decisions.md` (lignes datées), fiches citées.

- **Report d'époque : option B** (ADR 0011 §24 point 6, « survit tout ce que l'ouvreur n'avait pas lu, sauf ses propres écritures et celles d'un appareil oublié »), confirmée le 2026-10-17 ; question ouverte 13 fermée ; règle d'identité : une restauration ne change jamais l'identité de l'appareil ; compte rendu visible obligatoire (Y-TECH-05, livré).
- **B16 (Y-IOS-07) : rotation de segment, jamais de téléchargement avant l'ajout.** « L'écriture ne lit jamais iCloud » ; sur `cloud-pending`, ouvrir `max + 1`, une rotation par cycle, échec visible. Décision du 2026-10-17. Seule ouverture : une raison technique écrite dans la fiche, soumise à Ali avant le code.
- **B9 (N-TECH-02)** : fenêtre de 7 jours validée telle quelle, préfixe chronologique sans réserve par nature, pas de ligne « Plafond atteint » ; « Planifiés jusqu'au… » est calculé sur le **dernier rappel réellement posé**, pas sur la fenêtre visée (2026-10-18).
- **B10 (N-FIX-02)** : l'heure mise en avant est **l'heure d'échéance de l'élément** (`HH:MM · Pro/Perso`), jamais l'heure de sonnerie ; si le rappel a été décalé par la plage silencieuse, la mention du décalage vient **après** ; plus de parenthèse « (prévu HH:MM) » (2026-10-18).
- **B11 (UI-FIX-01)** : exemption de contraste 2,6:1 acceptée ; désactivé et éteint doivent rester distinguables l'un de l'autre ; Ali juge sur une capture des trois états côte à côte (clair et sombre), pas sur un ratio ; balayage complet des écrans sombres après la 1.0 (2026-10-18). Livré PR #57.
- **B12** : exigence `-apple-system-body` retirée du PRD, à revoir après la 1.0 (2026-10-17).
- **Bundle de départ : paliers 1 et 2 plus la garde par liste blanche, livrés quoi qu'il arrive**, bruit de hachage CSS traité dans le même lot (2026-10-18) ; paliers 3 (migrations) et 4 (synchro hors du départ) non retenus ; plafond jamais relevé ; tout nouvel écran à la demande dès sa création (règle dans `CLAUDE.md`). Branche : PR #61.
- **B18 (Y-FIX-05)** : avant la 1.0 (état faux muet des deux côtés) ; tolérance du lecteur seule, format publié inchangé, pas de `closed` à 0 enregistrement (2026-10-18). PR #60.
- **B15** : crochet NSIS `NSIS_HOOK_PREUNINSTALL`, pas de modèle NSIS personnalisé (2026-10-17). Livré.
- **Tri des défauts** (règle permanente du 2026-10-18) : voir `AGENTS.md`.
- **Y-FIX-02** : option (a), intention résolue seulement si la publication est permise (2026-10-18). Livré.
- **Méthode** : CI complète dans GitHub Actions, tests du module seuls en local ; un bloquant n'est clos qu'avec un test rouge avant et vert après ; alerte à +50 % d'estimation ; une compilation iPhone par lot ; Ali fait toutes les vérifications manuelles à la fin, ne jamais l'attendre pour continuer (hors besoin physique de l'iPhone).

## 6. Branches en vol et ce qui en a été fait le 2026-10-19

| Branche | État | Action faite | À faire |
| --- | --- | --- | --- |
| `y-fix-05-segment-tronque` | PR #60, CI verte | aucune | relecture puis fusion |
| `y-fix-03-lecture-en-echec` | PR #62 ouverte aujourd'hui | poussée, index du worktree réparé (`read-tree`) | CI, relecture, fusion |
| `t-tech-01-recurrences-synchro` | PR #63 ouverte aujourd'hui | M5 et M6 commités (`195dc3b3`), poussée | CI, bundle, fiche, fusion avant #61 |
| `bundle-01-paliers` | PR #61 ouverte aujourd'hui | docs commitées (`7b778c62`), poussée | CI, relecture, rebase après #63, fusion |
| `n-ios-apercus` | 1 commit `df8ab316` (N-IOS-FIX-01), jamais en PR | aucune | rebase, PR (section 4 point 5) |
| `y-tech-03-scenarios-rouges` | 1 commit `c41d5d66`, référence | gardée | ne pas fusionner : y reprendre les scénarios 4 (Y-IOS-02-FIX-01) et 6 (Y-IOS-07) ; supprimer après |
| `backup-y-fix-05-pre-rewrite` | sauvegarde avant réécriture des signatures (`ca3930b4`) | gardée | supprimer après la fusion de #60 |
| `fix-speech-timer-tests` | WIP du 2026-10-09 non relu (tests Rust du minuteur de dictée), retrouvé non commité dans un worktree | commité `cd9db3cf` et poussé tel quel | évaluer contre `main` 0.3.3 (aucune trace de ce défaut au journal depuis) ou supprimer |
| `fix-restore-ios-flaky` (PR #27) | remplacée par PR #47 | PR fermée avec commentaire, branche supprimée (`b2da5e59`) | rien |
| `wip-y-fix-04-2026-10-18` | sauvegarde de Y-FIX-04 avant la PR #49 fusionnée | supprimée (`fa57288c`) | rien |
| `wip-ordre4-amorce` | brouillon du 2026-10-05, tout dans `main` | supprimée (`0a92eeaa`) | rien |
| `rel-tech-02-rebased` | doublon de REL-TECH-02 fusionnée (#41) | supprimée (`13d1ac1e`) | rien |
| `y-ios-02-fix-01` | worktree créé le 2026-10-19 pour Codex, vide | worktree et branche supprimés | recréer au moment de la story |
| `passation-codex` | cette documentation | PR à fusionner | fusionner, puis supprimer |

Branches locales anciennes sans commit hors `main` (a-09-bandeaux, controle-ordre-*, dette-avant-ordre-3, fix-e2e-fusion-*, etc.) : à supprimer librement (`git branch --merged origin/main`).

## 7. Worktrees et restes à nettoyer

- Environ 70 worktrees sous `.claude/worktrees/` pour des branches déjà fusionnées, la plupart avec `node_modules`. Nettoyage sûr : `git worktree list`, puis `git worktree remove --force <chemin>` pour chaque branche fusionnée, puis `git worktree prune`. Garder ceux de #60 à #63 tant que les PR sont ouvertes.
- `.claude/worktrees/agent-acd50317fb4008648` (branche `qa-association`) contient une vieille variante non suivie de `src/features/sync/pairingDefects.test.tsx` (157 lignes) ; `main` a la version à jour (159 lignes) : à jeter avec le worktree.
- `.claude/worktrees/t-tech-01` contient `.bt/` et `.bt.sh` (script temporaire d'un agent, non suivis) : à jeter.
- Aucun stash en attente.

## 8. Signalements non vérifiés (audit Codex en lecture seule du 2026-10-19)

À vérifier avant d'agir ; aucun n'est au backlog :

- `src/domain/types.ts` : les marques imbriquées de `Brand` donneraient des types `never` (contrôle de compilation `SpaceId` ≠ `TaskId` à ajouter).
- `build-windows.yml` et `build-ios.yml` ne vérifient pas eux-mêmes que « suite verte » a réussi sur le commit livré.
- `src/features/stats/useMonthReport.ts` : le rapport mensuel ne se rafraîchit pas sur les changements de routines et d'objectifs.
- `src/platform/files/browser.ts` : annulation du sélecteur d'import iPhone dépendante de l'événement `cancel` (WKWebView).
- `statsRepository.ts` : tri paginé sur `COALESCE(date, …)` sans index d'expression.
- CI : pas de `cargo clippy` ni de `npm audit` ; projet e2e `iphone` en Chromium (WebKit seulement sur titres et roue tactile).
- `docs/dettes.md` mélange dettes ouvertes et points résolus.

Règle de tri de `AGENTS.md` : perte de données ou état faux muet → avant la 1.0, story ouverte, Ali informé ; sinon après.
