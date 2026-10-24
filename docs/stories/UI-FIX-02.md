# UI-FIX-02 — Paquet A, défauts constatés sur iPhone 1.0.0

Statut : en cours, aucune validation appareil acquise. Estimation initiale : 6 à 8 h actives ; alerte à 12 h. Une branche et une PR pour le paquet ; une compilation iPhone pour le lot terminé.

## Passe product-owner — 24 octobre 2026

Ordre imposé par Ali : (1) couleurs des états de synchronisation, (2) zones sûres de tous les écrans, (3) lecture jamais effectuée, (4) double « le », (5) gabarit des appareils, (6) noms lisibles et modifiables, identifiant secondaire, (7) rattachement sans objectif et chevauchement, (8) commande de fin unique, (9) expiration de signature remontée, (10) noms lisibles des champs de conflit.

Nouvelle tâche et Détail : corriger seulement ces défauts, pas de refonte avant les maquettes d'Ali. Noms d'appareils : préférer une préférence locale persistante sans migration ni modification du protocole de synchronisation. Ne jamais prétendre qu'un surnom local est partagé entre appareils. A9 reste le trou assumé décidé le 21 octobre ; aucun banc à reprendre.

## Preuves et validations

À consigner par point : preuve rouge avant modification, preuve verte après, limites natives. Lint, typage, revue à froid et CI complète avec couverture obligatoires. Bundle avant push et sur main après fusion ; plafond inchangé. Aucun point « fait » sans ces preuves.
