# Journal des versions

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
