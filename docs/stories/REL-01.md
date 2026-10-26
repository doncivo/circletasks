# REL-01 — Recette des douze parcours clés

## Verdict du candidat 1.0.1 — 26 octobre 2026

Recette native acceptée par Ali dans la conversation : dix contrôles du paquet A et autres essais natifs du guide réussis. Les vérifications automatiques, audit et publication de 1.0.1 sont consignés dans les sections ci-dessous et UI-FIX-02 ; ce retour clôt le volet physique attendu de cette livraison. A9 : non exécuté, risque accepté ; A6b : vérification future en usage après la 1.0, non exécutée et non bloquante. Aucun détail individuel de séance inventé. La refonte 1.0.2 relève d'UI-REFONTE-01 et reste à vérifier séparément.

Module : QA de livraison · Statut : automatisation intégrée #78 ; **recette physique ouverte** · Estimation **2 h actives**, alerte **3 h** ; les essais physiques sont séparés.

## Passe product-owner — 2026-10-21

Référence immuable : PRD §8, douze parcours de bout en bout sur PC et mobile ; §9, vérification de la synchronisation entre appareils avant livraison. Conserver les seuils de taille et couverture, les décisions de contraste et de taille iOS, l'interdiction de désinstaller pour mettre à jour le PC et le lot iPhone unique. Branche de préparation depuis N-IOS-FIX-01 ; aucune publication avant les fusions précédentes.

État de couverture lu : J01, J03 à J11 et J12 existent ; le README est en retard pour J10/J11. Le parcours J02 complet manque : les specs N-01 et N-03 isolent planification et action mais ne relient pas la création PC, la synchronisation, le plan iPhone et le retour de l'action au PC. Ce manque de preuve ne constitue pas une panne fonctionnelle démontrée.

## Acceptation

1. Les douze parcours sont reliés à leurs specs actuelles ; les limites du simulateur et les preuves physiques restent nommées.
2. Ajouter J02 avec deux vrais conteneurs applicatifs reliés au simulateur, horloge contrôlée, planificateur et source d'actions de notification de test. Créer la tâche sur PC, transmettre le rappel à l'iPhone, vérifier heure/titre/catégorie et absence d'envoi PC, injecter l'action native « Fait », puis vérifier son retour au PC et la disparition du rappel.
3. Ne pas présenter le faux planificateur comme une réception par iOS : livraison réelle, gestes natifs et conservation après mise à jour restent dans `docs/essais-iphone.md` pour l'IPA.
4. Aucun délai ajouté, retry automatique, skip de test instable ou timeout augmenté. Budget initial du nouveau parcours : 40 s, comme J10 qui ouvre deux applications et les synchronise ; les appels supplémentaires se bornent à cinq cycles applicatifs et à des attentes d'état.
5. Mettre à jour le guide des essais sans déplacer les cinq régressions en tête. Ne pas effacer les données réelles pour rejouer un premier lancement ; distinguer première installation simulée et mise à jour physique N → N+1.
6. QA ciblée, lint, typage et revue distincte ; suite complète avec couverture en CI, bundle avant push et après fusion. Aucun statut « fait » ni livraison finale sur une seule préparation.

## Preuves

Automatisation intégrée : **#78 fusionnée dans c5fc22ee**, tête **241daa87**, **48 contrôles verts** (39607713371 / 39607884918), couverture active, lint/typage et revue approuvée. J02 composé inclus dans les parcours PC/iPhone de la CI. Diff vérifié de la source applicative entre ios-v1.0.0 et main : vide ; aucun second build iPhone nécessaire. Le guide indique maintenant les preuves automatiques intégrées. **Recette physique encore ouverte** : aucune réception native, manipulation iCloud, caméra ou interaction UIKit déclarée passée.

Lot iPhone effectivement publié : run **39605174348**, jobs ios et publish verts, un seul build. IPA 1.0.0/build 1.0.0, identifiant conservé, minimum 18.0, **7 356 430 octets** ; SHA-256 **d993e7ed6f86c0ad0f7b8ec80cc8407b0ef0e31639aa66fb8a68ffed1de80057** concordant entre téléchargement, asset GitHub et source SideStore. Contrat Info.plist cinq plugins et contrôle source verts ; seuls les avertissements historiques de la version 0.1.0 restent, son entrée est conservée. Guide actualisé avec les preuves réelles ; réception physique toujours ouverte.

Reprise sur le main candidat **dcde7edc** (version 1.0.0, Vite 8.3.3) : seul le commit propre de recette est rejoué, devenu **27205581** ; guide récent conservé, conflits documentaires résolus sans perdre les états REL-02/REL-03. Dépendances exactes installées depuis le lock. J02 vérifié sur cette base : **2/2 verts en 42,0 s**, un worker, zéro retries, budget de 40 s par test inchangé. Aucun build lourd local pendant les tests. Lint/typage globaux verts ; bundle avant publication en cours. Le build iPhone **39605174348** porte sur le même code applicatif, les ajouts de recette ne changent pas l'IPA et ne justifient aucune nouvelle compilation.

Revue distincte de reprise : diff du test, du helper et du README relu ; initialisation des faux avant navigation, horloges alignées et retour de Fait au PC toujours vérifiés, aucun code applicatif modifié, **approuvée côté automatisation**. La recette physique reste ouverte. Le guide montré avant compilation trie les douze parcours et ne demande aucun rejeu des preuves automatiques.

Bundle préparatoire **58/58, 338 476 normalisés, 338 433 bruts, marge 19 924**, coût nul. Le guide reçoit le numéro cible 1.0.0 et les liens du run et de l'IPA, avec instruction explicite d'attendre run vert et disponibilité dans SideStore ; aucune publication présumée. Compte de signature SideStore habituel conservé. Relecture documentaire de cette précision approuvée, aucune modification des essais demandés ni nouvelle compilation.

J02 exécuté avant toute modification applicative : **2/2 verts**, projets PC et iPhone, **35,9 s** au total (13,4 s / 11,4 s par test), un worker, zéro retries. Chaque exécution ouvre ses deux applications ; cinq cycles pilotés, même tâche et même rappel, action native simulée et retour de l'état terminé au PC. Le PC ne planifie aucun rappel ; la requête iPhone est retirée après « Fait ». Le budget initial de 40 s est inchangé.

Le helper de synchro reçoit seulement un callback facultatif avant navigation pour installer les horloges et les faux au bon moment. Compatibilité des anciens J10 et J11 : **2/2 verts dans leur projet PC**, chacun ouvrant ses pages prévues ; leurs deux filtres iPhone préexistants sont inchangés (2 non-exécutions prévues, aucun nouveau skip). README rectifié pour ces trois parcours ; aucune preuve de réception par iOS ni validation de recette finale n'est inventée. Lint, typage, revue, CI complète et appareil encore requis.

Lint global et typage **verts**. Passe code-reviewer distincte : spec, helper et diff du README relus à froid ; **revue du code de recette approuvée**. Initialisation des faux avant navigation, horloges alignées des deux appareils avant action, espace isolé par exécution, nettoyage des contextes et du simulateur, assertions sur la requête exacte et sur l'état revenu au PC ; aucun code applicatif modifié. Cette préparation n'est pas encore publiée et doit être remise sur le main final du lot avant bundle et CI ; les autres parcours et l'appareil restent à consigner dans la recette finale.
