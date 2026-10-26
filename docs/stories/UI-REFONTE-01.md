# UI-REFONTE-01 — Nouvelle tâche et Détail

Statut : en cours, aucune validation ni publication revendiquée. Demande d'Ali du 26 octobre 2026 : « fait la refonte ». Estimation 6 à 8 h actives ; alerte à 12 h.

## Passe product-owner

Références : PR #84, docs/maquettes-refonte/Ajout-v2.html et Detail-v2.html, README de la même branche. Périmètre : ces deux écrans iPhone uniquement ; conserver les fonctions, les éditions PC et les dix corrections du paquet A. Pas de modification du PRD, du schéma ni du protocole. Aucun écran supplémentaire de la PR de maquettes n'est inclus.

Nouvelle tâche : titre sans cadre en grand, date et heure compactes ouvrant leurs sélecteurs, espace visible, répétition/rappel/projet/icône/objectif derrière Plus d'options ; action Ajouter la tâche toujours accessible au-dessus du clavier. Détail : espace sous le titre, échéance et rappels effectifs distincts avec explication du silence, projet séparé, objectif sans commande inutilisable, actions Reporter/Un jour/Dupliquer puis Focus/Supprimer. Défilement borné, thème sombre, texte long et paysage à vérifier.

## Résultats natifs précédents

Ali confirme le 26 octobre 2026 la réussite des dix contrôles du paquet A et des autres essais natifs du guide en 1.0.1. Ce retour vaut attestation utilisateur, pas mesure faite par Codex ; aucun horodatage individuel inventé. A9 reste non exécuté, risque accepté ; A6b conserve la règle « vérifié en usage après la 1.0 », aucune réception à deux jours n'est déduite de cette confirmation générale. Ces preuves précèdent la refonte et ne prouvent pas son rendu futur.

## Passe agent du module

Référence immuable des deux maquettes : bd3a80bf69d6dd76ce4834b7cf6d145e85ac5fd7 (PR #84, conservée intacte). Hôte de création synchrone pour le focus immédiat ; sélecteurs, styles et catalogue chargés par import() seulement à l'ouverture, avec la frontière d'erreur existante. Options repliées sans perte des choix ; état métier et écriture idempotente conservés. visualViewport borne le cadre des deux feuilles au-dessus du clavier. Sur Détail, le contenu central défile entre l'en-tête et les actions ; l'heure des rappels reprend reminderFireAt/effectiveFireAt et les vraies plages de l'espace. La note est enregistrée avant le lien vers les objectifs. Aucun remplacement de la base, aucune migration.

## Passe QA

Tests ciblés sans couverture ; suite complète avec couverture en CI, lint, typage et bundle avant push puis sur main après fusion. Vérification du clavier par visualViewport simulé et géométrie navigateur ; confirmation native distincte.

Première passe élargie : 871 verts / 5 échecs, 75 fichiers. Quatre oracles d'anciens accès immédiats adaptés puis 63/63 ciblés verts ; le fichier floatingTime inchangé vérifié dans son pool forks habituel, 3/3 verts (cause locale du pool threads consignée au journal). Premiers parcours iPhone : 14/14 verts, dont création, icône/note et géométrie clair/sombre/paysage ; contrôle complémentaire de l'en-tête après retour d'une sous-feuille et défilement, 1/1 vert. Lint sans avertissement et typage strict verts ; validation du diff final et suite CI restent requises. Les libellés de sauvegarde partagés des parcours acceptent les deux commandes propres à leur formulaire (Ajouter la tâche / Enregistrer) ; les assertions de données, de conservation et d'erreurs sont maintenues.

## Passe code-reviewer

Relecture distincte du diff final depuis 9ddb7781 et des nouveaux modules, après la passe QA : approuvée. Le titre et les états de création restent dans l'hôte synchrone, les choix repliés ne sont pas démontés ; l'action est désactivée tant que le bloc n'est pas arrivé, l'échec de chargement utilise la frontière visible avec Réessayer. Le cadre suit visualViewport avec retrait des deux écouteurs à la fermeture. La note et le choix de portée passent par la même fermeture contrôlée avant navigation ; le lien vers les objectifs n'est proposé que pour la semaine courante, seule semaine que cet écran édite. PC conserve ses champs éditables et son ordre d'actions. Aucune écriture métier, dépendance transitive, migration ou donnée utilisateur modifiée.

Preuves finales : 72 tests ciblés du module dans le pool habituel, lint sans avertissement, typage strict ; 14 parcours initiaux, 31 complémentaires puis les trois anciens accès corrigés et les trois contrôles de géométrie finale (6/6). Les 12 exclusions de projet de la passe complémentaire étaient préexistantes ; aucun test instable sauté, aucun retry ni seuil modifié. WebKit inclut désormais les trois contrôles de refonte dans la CI. Le rendu physique futur reste ouvert dans le guide (quatre contrôles seulement, sans rejeu des essais 1.0.1).

Garde du démarrage : rouge fbbcba02 (10 modules sortis et nouvelle attribution de DateField.css dans la carte JS), retrait des dix autorisations obsolètes. Unique ajout explicite UI-REFONTE-01 : DateField.css inchangé, nécessaire au premier affichage PC ; ses 25 classes étaient déjà dans les CSS initiaux de main #85, vérification contre le build conservé. Aucun écran secondaire autorisé au départ. Mesure de production : **333 808 normalisés, 333 781 bruts, marge 24 592**, soit **5 390 octets économisés** par rapport à 1.0.1. Plafond 358 400 et couverture 80 % inchangés. Garde complète **62/62 verte** après resserrement ; CI complète finale requise avant fusion.
