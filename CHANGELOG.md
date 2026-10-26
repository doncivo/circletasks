# Journal des versions

## Non publié

## 1.0.2

- Nouvelle tâche sur iPhone : titre prioritaire, date et heure compactes, espace visible, options repliées et action Ajouter la tâche au-dessus du clavier.
- Détail : échéance et heures des rappels séparées, explication du décalage silencieux, projet distinct, actions courantes avant Focus et suppression. Les comportements PC restent conservés.
- Aucun changement de schéma (19) ni du protocole de synchronisation. Vérifications automatiques et publication PC/iPhone validées ; quatre contrôles du rendu sur appareil restent à confirmer avec ce lot.

## 1.0.1

- Paquet A issu des essais sur iPhone 1.0.0 : attente de synchronisation distincte du succès, mention « Jamais lu », appareils alignés avec noms modifiables localement et identifiants secondaires, champs de conflit nommés explicitement.
- Zones sûres des écrans et des feuilles : le défilement reste sous la barre d'état. Correction du texte de création, du rattachement sans objectif et de la commande circulaire ambiguë sur Détail ; l'icône reste modifiable via « Modifier ». Expiration SideStore remontée en tête de Réglages.
- Aucun changement de schéma ni de protocole de synchronisation. Correctifs vérifiés automatiquement ; rendu natif à confirmer sur le lot iPhone. La refonte de Nouvelle tâche et Détail attend les maquettes d'Ali.

## 1.0.0

- Lot candidat iPhone : les vérifications natives du guide `docs/essais-iphone.md` restent à exécuter ; la publication de l'IPA ne vaut pas validation de la recette 1.0.
- Synchronisation : reprise de publication interrompue, rotation quand le segment iCloud est évincé, refus de clore un segment tronqué et suppression des doublons de récurrences. Les erreurs de suppression et de lecture restent visibles jusqu'au succès de l'opération concernée, y compris après une réussite partielle et un redémarrage.
- Rappels iPhone : fenêtre chronologique de sept jours limitée à 64 demandes, couverture annoncée selon les demandes réellement posées ; heure d'échéance conservée et mention du report silencieux placée en dernier. Texte de remplacement par catégorie lorsque les aperçus sont masqués.
- iPhone : focus du clavier des checklists et gardes de réouverture des sélecteurs et confirmations. Le rendu natif et les notifications réelles sont à vérifier avec ce lot.
- Qualité et sécurité : écrans et textes secondaires chargés à la demande sous le plafond inchangé ; clé de signature Windows séparée du build frontal ; dépendances de vérification TLS mises à jour.

- Désinstallation : la case « Supprimer les données de l'application » du désinstalleur Windows est désormais sans effet. Vos tâches, vos sauvegardes locales et vos réglages sont toujours conservés, que vous désinstalliez depuis Windows ou que vous choisissiez « Désinstaller avant d'installer ». Pour effacer vos données, supprimez à la main les dossiers de l'application (voir docs/install-pc.md).
- Attention : cette protection existe à partir de cette version. Avant, cocher cette case supprimait vos données.
- Qualité : l'installation, la réinstallation et la désinstallation de l'application Windows sont testées à chaque suite sur un vrai installeur.

## 0.3.3

- Synchronisation : la publication d'un appareil bloquée par un instantané d'ancienne époque resté dans iCloud se débloque seule au premier cycle, sans réassociation ; la cause réelle d'un refus de publication est journalisée ; un fichier iCloud évincé est correctement supprimé par l'app sur iPhone.
- Vérification à faire par Ali sur l'iPhone (fiche docs/stories/Y-IOS-02-FIX-02.md, section « Vérifications manuelles d'Ali ») : après la mise à jour 0.3.2 vers 0.3.3 par SideStore, le bandeau « Cet appareil n'a pas encore publié son état » disparaît au premier cycle, le PC voit l'iPhone dans Réglages > Synchronisation > Détails, une tâche créée d'un côté apparaît de l'autre, le fichier `s-00000001.cts` de l'ancienne époque a disparu d'iCloud Drive, et les journaux exportés montrent `orphan-epoch-relisted` puis `orphan-epoch-deleted`.

## 0.3.2

- iPhone : la roue des heures de « Nouvelle tâche » se règle au doigt (elle restait bloquée sur « 01 ») ; les rappels se cochent dès qu'une heure est posée.
- Synchronisation : un oubli d'appareil en échec peut être annulé (« Annuler la demande ») ; « Réessayer » repasse par la confirmation de l'app.
- Qualité : test de fumée du vrai binaire Windows à chaque suite (écran du jour vérifié à l'écran), suite de tests indépendante du calendrier.

## 0.3.1

- Version de test de la mise à jour : aucune autre modification que le numéro de version. Elle sert à vérifier que SideStore propose et installe la mise à jour depuis la 0.3.0, données conservées.

## 0.3.0

- Mise à jour de l'iPhone par SideStore : la source CircleTasks propose chaque nouvelle version ; le numéro de version est affiché dans Réglages > À propos et la synchronisation publie le vrai numéro de l'iPhone (plus de « 0.0.0 »).
- Les rappels sont replanifiés au premier lancement d'une nouvelle version.
- Synchronisation : l'iPhone rejoint correctement l'état du PC au lieu d'ouvrir sa propre époque ; une époque orpheline est abandonnée au profit de celle du PC, sans perte de données.
- « À jour » n'est plus affiché tant que l'état n'a pas été publié et lu en entier.
- Une clé importée n'est jamais prise pour celle du premier appareil ; actions « Démarrer la synchro depuis cet appareil » et « Lancer une reprise complète » proposées en cas d'avertissement.
- Agenda : un compte reçu du PC sans secret local s'affiche « Connecté ailleurs » (plus de faux bandeau « déconnecté ») ; « Connecter ici » connecte l'iPhone sous une référence neuve.
- iPhone : titres datés de Tâches et de la Semaine sur une ligne à côté de leurs boutons ; titre « Synchronisation » des Détails sur une ligne.
- Si la mise à jour des données échoue au démarrage : versions affichées et bouton « Restaurer la sauvegarde d'avant la mise à jour ».
- Une version plus ancienne que les données ne les modifie pas et indique d'installer la dernière version.
- PC et iPhone exécutent le même code de synchronisation : mets les deux appareils à jour.

## 0.2.3

- Association : chaque état propose l'action utile (PC oublié, dossier à rechoisir, clé illisible, Trousseau indisponible), étapes de la fenêtre QR dans le bon ordre ; tests du parcours complet.

## 0.2.2

- Correction : base de données verrouillée au premier lancement sur iPhone.
- Le diagnostic d'ouverture affiche le mode de journal effectif de la base ; une ouverture sans réponse après 15 s affiche l'étape en cours et un bouton « Réessayer ».
- Association PC/iPhone : bouton visible sur le PC, association toujours proposée sur l'iPhone sans clé, aucune clé créée sans choix explicite, synchro ralentie au lieu d'arrêtée sur erreur passagère.

## 0.2.1

- Diagnostic d'ouverture de la base affiché.

## 0.2.0

- Rappels envoyés par notifications sur l'iPhone, avec les actions « Fait » et « +15 min » directement depuis la notification.
- Synchronisation entre le PC et l'iPhone par journaux chiffrés dans iCloud Drive.
- Installation de l'iPhone par SideStore (source CircleTasks).

## 0.1.1

- Validation de la mise à jour automatique sur PC (D-03) : aucune autre modification.

## 0.1.0

- Première version publiée de CircleTasks pour PC.
