# Y-IOS-06 — Gardes de présentation du sélecteur et de la confirmation iOS

Module : plugin iOS folder-bookmark · Palier 1.0 · Estimation **3 h actives** (avec C-FIX-01, total 5 h), alerte au-delà de **4,5 h** · Statut : en cours, passe product-owner du 2026-10-20.

## Passe product-owner

Constat déjà dans l'audit : les interactions `pickFolder` et `confirm` n'ont pas les mêmes gardes ; le sélecteur peut remplacer son délégué lors d'un second appel, et une confirmation peut se présenter pendant un sélecteur. Conserver le contrat local et les commandes sans échéance pendant un choix utilisateur. Factoriser les préconditions sur le fil principal : premier plan, interaction libre et présentateur attaché sans transition. Les refus utilisent les codes existants (`not-foreground` uniquement pour l'app inactive, `io` pour une présentation impossible). Aucun code de protocole, texte, accès fichier ou budget modifié.

La référence du délégué doit être libérée après choix, annulation et fermeture interactive ; une réponse au maximum, même si deux callbacks UIKit arrivent. La confirmation conserve sa réponse unique et son annulation au passage en arrière-plan. Source indépendante du front en validation ; fusion après C-FIX-01, remise sur main avant push.

## Critères

1. Les deux commandes passent sur le fil principal et utilisent la même garde avant de mémoriser leur interaction ou de présenter une interface.
2. App inactive : refus `not-foreground`. Sélecteur ou confirmation déjà en cours : refus visible `io`, sans écraser le délégué ou la réponse de la première interaction.
3. Contrôleur absent, vue non attachée, présentation ou fermeture en cours : refus `io`, aucune interface nouvelle. Le présentateur est le dernier contrôleur présenté.
4. Choix et annulation du sélecteur répondent une fois ; la fermeture interactive produit une annulation et permet une nouvelle ouverture. La confirmation et son annulation en arrière-plan gardent leur comportement.
5. Gardes de source rouges avant correctif puis vertes ; contrat Swift/Rust et tests du module verts, lint et typage, revue consignée, CI complète avec couverture avant fusion. Ces contrôles de source ne seront pas présentés comme une exécution de UIKit.
6. Aucun module front ajouté, bundle avant push puis sur main après fusion, plafond inchangé. Aucune donnée utilisateur réelle consultée.
7. Compilation Swift avec l'unique lot iPhone, puis essai d'Ali : ouvrir, annuler par bouton et par balayage puis rouvrir ; deux demandes rapprochées ne doivent produire qu'une interface, et la première doit rester utilisable. Mettre l'app en arrière-plan pendant une confirmation doit la refuser proprement au retour. Critère physique ouvert jusqu'à l'essai de l'IPA.

## Passes et preuves

Product-owner consigné avant code. Preuves de source, correctif, QA et revue à compléter ; aucun statut « fait » revendiqué avant vérification appareil.
