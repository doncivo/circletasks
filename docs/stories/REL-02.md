# REL-02 — Audits de livraison 1.0

Module : sécurité, performance, accessibilité · Estimation **3 h actives**, alerte à **4,5 h** · Statut : audit automatique consigné, IPA publiée et vérifiée ; **appareil et signature PC ouverts**. Aucune conformité finale revendiquée. L'avenant B5 de 5 h est historique, corrigé et fusionné #72.

## Passe product-owner — 2026-10-20

Préparer les contrôles indépendants pendant la CI du lot, puis conclure sur le main livré. Aucun changement de fonction, de seuil ni de décision : bundle 358 400 octets, couverture du domaine 80 %, contraste désactivé 2,6:1 accepté, taille de texte iOS différée. PRD immuable, données personnelles hors dépôt interdites. Les vérifications physiques restent à exécuter avec l'IPA unique.

## Critères

1. Dépendances et secrets : audit npm à jour, audit Rust et garde de dépendance compilée verts en CI, aucun secret suivi ; exceptions déjà décidées conservées et expliquées.
2. Fiabilité : revoir les changements du lot et vérifier les cas limites signalés, sans déclarer un défaut sur une hypothèse seule. Toute perte de données ou tout état faux confirmé déclenche l'arrêt convenu avec Ali, une fiche et une preuve rouge ; aucune correction fonctionnelle improvisée dans cet audit.
3. Performance : budgets de démarrage, navigation, recherche et bundle inchangés, contrôles CI verts sur le commit de livraison ; contrôles réels iPhone séparés des simulations.
4. Accessibilité : clavier, focus, états, erreurs et textes des changements relus ; essais appareil explicitement ouverts tant que non exécutés. Aucune décision de contraste ou de taille de texte rouverte.
5. Revue distincte, lint, typage et suite complète avec couverture avant clôture ; docs/backlog.md, docs/audit-1.0.md et docs/journal.md actualisés au niveau des preuves.

## Préparation déjà vérifiée

Audit du candidat 1.0.0 consolidé dans `docs/audits/2026-10-21-lot-1.0.md` : source dcde7edc et arbre vérifié, 48 CI verts de #76, npm frais zéro avis, audits Rust/garde RSA et performance verts, bundle main 338 476 marge 19 924. Revue documentaire approuvée sur ces preuves ; compilation Swift et publication IPA effectivement vertes dans 39605174348, métadonnées et empreinte vérifiées. Réception physique, accessibilité native et signature PC restent ouvertes. Ce constat remplace les états historiques ci-dessous sans déclarer la livraison conforme avant ses preuves finales.

Actualisation du 2026-10-21 : l'ancien « npm 0 avis » ci-dessous est historique. Nouvel audit rouge **72154cc0**, Vite 8.3.2 affecté par trois avis publiés dans la base le 20 octobre ; correction minimale 8.3.3 et audit vert code 0. Détails et revue dans `docs/audits/2026-10-21-npm-vite.md`. Lint/typage/bundle et CI finale requis ; audit de livraison et appareil restent ouverts. Le B5 décrit historiquement ci-dessous est désormais corrigé et fusionné #72, avec ses rouges propres.

Sur les dépendances du lot avant version finale : `npm audit` **0 avis**, code 0 ; empreinte des entrées de dépendances du lockfile (hors paquet racine) `6e47521b0f7a4a08e23fa968f4599613c5406e328dc6347d9bd0b14958c02fa4`. RUSTSEC-2023-0071 : exception documentée dans docs/dettes.md, dépendance de sqlx-mysql non compilée ; garde CI « rsa jamais compilé » conservée, arbre Windows local vide. Ces constats ne remplacent pas la validation finale du lot.

Vérification ciblée réalisée : **rouge `016dbd04`**, suppression partielle d'une ancienne époque et substitut conservé après refus `io`. Le service montre « À jour · à l'instant », avec cause persistée effacée. Complément B5 rattaché à Y-IOS-02-FIX-01, sans nouvelle story. Arrêt convenu sur état faux confirmé par le banc ; pas de correction fonctionnelle ni de conclusion finale d'audit.
