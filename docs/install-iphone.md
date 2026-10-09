# Installer CircleTasks sur l'iPhone

Ce guide est pour l'iPhone 16 Pro Max (iOS 18 ou plus). Il ne demande ni Mac ni compte Apple Developer payant : un Apple ID gratuit suffit. L'installation de départ se fait une seule fois depuis le PC Windows ; ensuite tout se passe sur l'iPhone.

Durée : 15 minutes environ, lecture comprise (iTunes et iloader déjà téléchargés). Ensuite, une mise à jour prend 2 minutes.

Un Apple ID gratuit limite à 3 apps installées hors App Store. SideStore en occupe une, CircleTasks une autre. Les apps ainsi installées expirent au bout de 7 jours : SideStore les renouvelle (étape 8).

## Ce qu'il faut avoir

- Le PC Windows, l'iPhone et son câble USB.
- Un Apple ID (gratuit). Mieux vaut un identifiant dédié si l'identifiant principal t'inquiète ; l'identifiant sert seulement à signer.
- Une connexion Wi-Fi.

## 1. Installer iTunes depuis le site d'Apple

iloader a besoin des pilotes Apple fournis par iTunes. Il faut la version du site d'Apple, **pas** celle du Microsoft Store.

1. Va sur apple.com/fr/itunes et télécharge « iTunes pour Windows » (lien de téléchargement direct sous le bouton du Microsoft Store).
2. Installe-le, puis ouvre-le une fois. Branche l'iPhone et accepte « Faire confiance à cet ordinateur » sur l'iPhone.

## 2. Activer le mode développeur sur l'iPhone

1. Réglages > Confidentialité et sécurité > tout en bas, « Mode développeur ».
2. Active-le. L'iPhone redémarre ; confirme l'activation au redémarrage avec ton code.

Si l'option n'apparaît pas, elle s'affiche après la première installation d'une app par iloader (étape 3) : reviens alors à cette étape.

## 3. Installer SideStore avec iloader

1. Télécharge iloader depuis sa page officielle (github.com/nab138/iloader) et lance-le.
2. Iphone branché en USB, connecte-toi avec ton Apple ID dans iloader.
3. Choisis « Installer SideStore ». Attends la fin.
4. Sur l'iPhone : Réglages > Général > VPN et gestion de l'appareil > ton Apple ID > « Faire confiance ».
5. Dans iloader, utilise aussi la fonction qui place le **fichier d'appairage** (pairing file) dans SideStore. Sans lui, SideStore ne peut pas renouveler les apps.

## 4. Installer le VPN local

SideStore parle à l'iPhone lui-même par un VPN local. Installe **LocalDevVPN** (ou **StosVPN**) depuis l'App Store, ouvre-le, puis active la connexion. Accepte l'ajout de la configuration VPN. Le VPN doit être actif à chaque installation ou renouvellement.

## 5. Ajouter la source CircleTasks dans SideStore

1. Ouvre SideStore, onglet « Sources », bouton « + ».
2. Colle l'adresse : `https://raw.githubusercontent.com/doncivo/circletasks-releases/main/source.json`
3. Valide. CircleTasks apparaît dans la source (identifiant `fr.circletasks.planner`).

## 6. Installer CircleTasks

1. Ouvre la source CircleTasks, touche « Gratuit » (ou « Installer ») à côté de CircleTasks. Garde le VPN actif et reste en Wi-Fi.
2. L'installation prend un moment. L'icône apparaît sur l'écran d'accueil.
3. Premier lancement : si l'iPhone parle d'un développeur non approuvé, refais l'approbation de l'étape 3.4.

### Variante : importer l'IPA à la main

Si la source n'est pas encore publiée : télécharge `CircleTasks.ipa` (artefact du workflow « Build iOS » sur GitHub, à dézipper), envoie-le sur l'iPhone (AirDrop, iCloud Drive), puis dans SideStore touche « + » en haut de « Mes apps » et choisis le fichier.

## 7. Mises à jour de CircleTasks

Quand une nouvelle version est publiée, elle apparaît dans la source avec ses notes. Dans SideStore, ouvre la source (ou « Mises à jour ») et touche « Mettre à jour ». Les données de l'app sont conservées tant que tu ne la supprimes pas.

## 8. Renouveler tous les 7 jours

- Ouvre SideStore, VPN actif, en Wi-Fi, et touche « Tout actualiser » (Mes apps). Le faire tous les 5 ou 6 jours est plus sûr.
- SideStore peut le faire seul en arrière-plan ; une automatisation Raccourcis qui ouvre SideStore chaque jour aide.
- CircleTasks vous prévient 24 h avant l'expiration ; actualisez-la alors dans SideStore. La date d'expiration lue par l'app est affichée dans Réglages, rubrique « À propos ».

## Pour publier une version (une fois, côté GitHub)

Une seule fois : dans le dépôt CircleTasks sur GitHub, Settings > Environments > `releases` (New environment s'il n'existe pas), ajoute le secret `RELEASES_TOKEN` (jeton limité au dépôt circletasks-releases, droit « Contents : écriture »). Aucune approbation manuelle n'est demandée (décision du 2026-10-07). Recommandation facultative : dans « Deployment branches and tags », limite aux tags `ios-v*` et `v*`.

Secrets de dépôt pour Google Agenda (noms seulement, valeurs dans GitHub) : `CT_GOOGLE_CLIENT_ID` et `CT_GOOGLE_CLIENT_SECRET` (client « Application de bureau », build PC), `CT_GOOGLE_IOS_CLIENT_ID` (client « iOS », build iPhone). Seul un tag `ios-vX.Y.Z` publie (X.Y.Z = version de l'app) ; un lancement du workflow « Build iOS » sur une branche produit seulement l'IPA en artefact, même avec « publish » coché.

## Si ça se passe mal

| Problème | Que faire |
|---|---|
| iloader ne voit pas l'iPhone | Vérifie iTunes (version du site d'Apple), le câble, la confiance de l'ordinateur sur l'iPhone. |
| « Impossible de vérifier l'application » | Approuve le profil dans Réglages > Général > VPN et gestion de l'appareil. |
| Le renouvellement échoue | Active LocalDevVPN/StosVPN, passe en Wi-Fi, ferme et rouvre SideStore. Vérifie le fichier d'appairage. |
| CircleTasks ne s'ouvre plus (expirée) | Renouvelle-la dans SideStore. Ne la supprime pas : tu perdrais les données locales. |
| SideStore lui-même ne s'ouvre plus | Réinstalle-le avec iloader depuis le PC (étape 3). Les apps déjà là restent à renouveler ensuite. |
| Plus de place (3 apps max) | Supprime une autre app installée hors App Store, ou patiente 7 jours. |
