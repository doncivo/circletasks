# C-FIX-01 — Focus du titre de checklist dans le geste d'ouverture

Module : checklists et iOS · Palier 1.0 · Estimation **2 h actives** (avec Y-IOS-06, total 5 h), alerte au-delà de **3 h** · Statut : en cours, passe product-owner du 2026-10-20.

## Passe product-owner

Constat déjà porté à l'audit 1.0 : `ChecklistForm` attend un `setTimeout(0)` pour focaliser le titre après le piège de focus. Ce délai sort du geste d'ouverture et empêche la montée automatique du clavier dans WKWebView, comme l'ancien défaut Q-05. Réutiliser `initialFocusRef` de la feuille et `initialFocus` du piège, comme la feuille de création d'une tâche, sans minuterie. La maquette Checklists et la feuille existante gardent leur présentation ; aucun texte ni nouvelle interface. Dossier indépendant de la publication et des rappels en validation ; fusion après CI-SEC-01, remise sur main avant push.

## Critères

1. À l'ouverture de « Nouvelle checklist », le titre reçoit le focus dans le même rendu que le geste, avant toute minuterie ; le piège le conserve sur iPhone 440 et 393 px, et sur le panneau PC.
2. Saisir le titre conserve le focus ; Échap ferme la feuille ou le panneau et rend le focus à l'action d'ouverture. Les règles de création, d'espace et de validation ne changent pas.
3. Une modification de checklist existante ne prend pas un nouveau focus automatique dans le titre ; les pièges de focus existants restent actifs.
4. Preuve rouge synchrone avant code, puis verte après ; tests du module, lint, typage, revue consignée et suite complète avec couverture avant fusion.
5. Mesure du bundle avant push puis sur main après fusion ; aucun module ajouté au départ, aucun seuil modifié.
6. Après compilation unique du lot, essai d'Ali sur l'iPhone : ouvrir une nouvelle checklist → clavier immédiatement visible et titre actif, taper puis créer → champ « Nouvel élément » actif ; ajouter plusieurs éléments → champ de saisie visible avec le clavier. Ce critère physique reste ouvert tant qu'Ali ne l'a pas vérifié ; aucune simulation ne sera présentée comme une preuve du clavier iOS.

## Passes et preuves

Remise sur main après #69 (`ea596996`) avant premier push : rouge `ee2b51ab` devenu `e2bac0ec`, correctif `3b716ac4` devenu `292e9e59`, revue `fb5f679f` devenue `95a76c61`. Le blob du test rouge est identique avant et après rebase (`465c652fe51bbb975e88da745dbee46d64b044e5`). Conflits documentaires résolus en conservant les preuves de N-FIX-02 et CI-SEC-01 ; aucun conflit de code.

Product-owner consigné avant code. Tests rouges, qa-test, revue et CI à compléter ; la fiche ne porte pas « fait » avant ses vérifications.

Rouge **`ee2b51ab`** : **3/3 échecs** à 440, 393 et 1440 px, focus reçu sur « Fermer » au lieu du titre dans le geste d'ouverture. Les assertions sont synchrones, sans temporisation ni promesse après le clic. Le test PC utilise son libellé existant « + Nouvelle checklist ».

Correctif : référence du titre portée par `ChecklistsScreen`, donnée au formulaire et à son hôte seulement pour la création ; `Sheet` / `EditorPanel` confient la focalisation à leur piège après capture de l'élément d'ouverture. Minuterie retirée, focus automatique absent en modification. Un simple `autoFocus` sur l'enfant avait échoué aux trois assertions de restitution du focus : le piège capturait alors le titre au lieu du bouton d'ouverture ; le passage par `initialFocusRef` corrige les deux sens de la transition.

Passe qa-test : **3/3 verts** pour focus immédiat, saisie et fermeture avec restitution, puis **91 tests / huit fichiers du module verts**, couverture coupée ; lint global vert. La montée et la visibilité du vrai clavier ne sont pas prouvées par ces tests : critère 6 ouvert jusqu'à l'IPA. Typage, revue distincte, remise sur main après CI-SEC-01, bundle et CI complète encore requis.

Typage final vert : référence du titre typée `RefObject<HTMLInputElement>` pour React 18 (la nullabilité de `current` est déjà portée par cette interface). **Passe code-reviewer distincte approuvée** après relecture du diff de `3b716ac4` et de cette annotation : focus donné au piège de l'hôte après capture de l'action d'ouverture, création seulement, saisie sans vol de focus et restitution sur Échap ; minuterie supprimée, édition conservée, aucun écran ni catalogue ajouté. Le code reste en validation jusqu'à remise sur main, bundle et CI ; critère physique 6 toujours ouvert, aucun statut « fait » revendiqué.
