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

À faire sur le diff final, indépendamment de l'écriture. Aucun statut « fait » avant tous les contrôles requis.
