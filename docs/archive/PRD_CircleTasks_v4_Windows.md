# PRD — CircleTasks v4.0 (application Windows · Tauri 2)

**Version :** 4.0 · **Date :** 07/07/2026 · **Auteur :** Ali (JYN INFO CONSEIL)
**Cible :** PC Windows 10/11, application de bureau native **Tauri 2** (React + Vite), résidente en barre système, démarrage avec Windows
**Usage du document :** spécification de référence pour développement assisté par Claude Code — chaque section est autoportante et consommable indépendamment.

---

## 0. Sommaire

1. Contexte, objectifs et contraintes
2. Design system
3. Navigation et shell applicatif
4. Spécifications écran par écran (avec états)
5. User stories et priorisation MoSCoW
6. Règles de gestion et cas limites
7. Modèle de données (TypeScript + DDL SQLite + migrations)
8. Fonctions pures critiques (signatures + cas de test)
9. Architecture technique
10. Notifications locales
11. Permissions et comportements de repli
12. Sauvegarde et restauration
13. Gestion des versions (verrouillage strict)
14. Workflow de développement et publication
15. i18n
16. Limitations, risques et parades
17. Roadmap
18. Plan de test et critères d'acceptation

---

## 1. Contexte, objectifs et contraintes

### 1.1 Objectif
Développer une application de bureau Windows de gestion de tâches quotidiennes, clone fonctionnel complet de Note Circle, toutes fonctionnalités premium débloquées. Frontend React (Vite) embarqué dans **Tauri 2** : binaire léger, SQLite sur disque, notifications Windows natives, icône en barre système et lancement au démarrage — l'app vit en permanence pour assurer les rappels. 100 % offline, aucune dépendance à un compte ou un store.

### 1.2 Contraintes structurantes
| Contrainte | Impact |
|---|---|
| Rappels à heure fixe, app "fermée" | L'app doit résider dans la barre système et démarrer avec Windows ; fermer la fenêtre = réduire au tray, jamais quitter |
| Pas de signature de code | Avertissement SmartScreen à la première installation (1 clic « Exécuter quand même ») — assumé pour un usage personnel |
| Usage personnel, un seul PC | Pas de monétisation, pas d'analytics, pas de compte, pas de sync cloud |
| Toolchain | Rust requis pour builder ; la logique métier reste 100 % TypeScript (le Rust se limite au shell Tauri) |

### 1.3 Ce qui change vs l'app d'origine
| Fonction d'origine | Adaptation Windows/Tauri |
|---|---|
| Compte (email + déconnexion) | Supprimé — remplacé par la section "Sauvegarde" |
| Intégrations Apple Reminders / Calendar | Sans objet sur Windows → export ICS universel (importable dans Outlook/Google) |
| Rappels | ✅ Notifications **Windows natives** émises par le planificateur interne (§10) — l'app résidant au tray, elles fonctionnent fenêtre fermée |
| Scan de tâches (OCR) | ✅ De retour en V1.1 : import d'image/capture + Tesseract.js (aucune contrainte native sur PC) |
| Gestes tactiles (swipe jours/onglets) | Boutons ‹ › + molette + **raccourcis clavier** (§3) |
| Paywall "Note Plus", "Meet Our Family" | Supprimés |

### 1.4 Non-objectifs (hors périmètre V1)
Synchronisation multi-appareils, mode collaboratif, version mobile, push distant, sous-tâches, pièces jointes, tags/projets, signature de code / distribution store.

---

## 2. Design system

### 2.1 Palette

| Token | Light | Dark | Usage |
|---|---|---|---|
| `bg.primary` | `#FFFFFF` | `#1C1526` | Fond des écrans |
| `bg.secondary` | `#F4F2F7` | `#2A2138` | Champs de saisie, cartes |
| `text.primary` | `#3D2E5C` | `#EDE8F5` | Titres, corps |
| `text.secondary` | `#6E6288` | `#A99EC2` | Sous-titres, heures, placeholders |
| `tab.todo` | `#A8B48F` | idem assombri −15 % | Onglet Todo |
| `tab.routine` | `#F2938C` | idem | Onglet Routine (personnalisable) |
| `tab.event` | `#8FB4C4` | idem | Onglet Event (personnalisable) |
| `tab.checklist` | `#E5DCB3` | idem | Onglet Checklist (personnalisable) |
| `tab.settings` | `#3D2E5C` | `#171122` | Onglet Settings |
| `accent.danger` | `#E5484D` | `#FF6369` | Se déconnecter, suppression |
| `accent.info` | `#4C9EEB` | `#67B0F0` | Badge TODAY, liens |
| `state.disabled` | `#D9D4E3` | `#4A4060` | Toggles off, éléments verrouillés |

Palette "Customize Tabs" (8 choix par onglet) : `#F2938C`, `#E5A96B`, `#E5DCB3`, `#A8B48F`, `#8FB4C4`, `#9B8CC4`, `#D48CB4`, `#8C8C8C`.

### 2.2 Typographie
| Style | Police | Taille (Moyen) | Usage |
|---|---|---|---|
| `display` | **Lora Bold** (Google Fonts, via `expo-font` — serif signature) | 40 pt | Titres d'écran ("Settings", "Routine"), jour du Todo |
| `title` | Inter SemiBold | 22 pt | Titres de sections settings, noms de tâches |
| `body` | Inter Regular | 17 pt | Corps, items |
| `caption` | Inter Regular | 14 pt | Heures, légendes, compteurs |

Réglage "Taille de police" : facteur ×0,88 (Petit), ×1 (Moyen), ×1,15 (Grand) appliqué via un hook `useScaledFont()`. Aucune taille codée en dur dans les composants.

### 2.3 Espacements, formes, élévation
- Grille de 4 pt. Marges d'écran : 24 px. Espacement inter-items : 16 px vertical.
- Rayons : cases à cocher 8 px ; boutons pill 999 px ; cartes/champs 16 px ; onglets latéraux arrondis vers l'extérieur 20 px.
- Séparateurs : trait 1 px `bg.secondary` + petit tiret décoratif 24 px sous chaque titre de section (signature visuelle).
- Pas d'ombre portée : hiérarchie par la couleur et les fonds.

### 2.4 Composants récurrents
| Composant | Spécification |
|---|---|
| `Checkbox` | 28×28, bordure 2 px `text.primary`, coche animée (scale 0→1 spring 300 ms) + haptique `light` + son (si activé). Texte barré `text.secondary` après coche. |
| `RadioRow` | Cercle 24 px, point intérieur 10 px, groupe horizontal ou vertical. |
| `Toggle` | Switch iOS natif re-stylé : track `state.disabled` → `text.primary`. |
| `FAB` | 64 px, `tab.settings`, "+" blanc, bas-droite, marge 24 px, safe-area aware. |
| `PillButton` | Contour 1,5 px, fond transparent ("Mensuel", "Calendrier", "Réorganiser"). |
| `TabRail` | Rail vertical gauche 72 px, onglets en texte pivoté −90°, onglet actif : fond `bg.primary`, débord arrondi. |
| `BottomSheet` | Création/édition (todo, routine, event, item). Drag-to-dismiss, fond assombri 40 %. |
| `EmojiPicker` | Grille 8 colonnes, catégories, recherche, récents (max 24 stockés). |
| `DayDots` | 7 pastilles L M M J V S D (ordre selon début de semaine), 36 px, actives = fond couleur d'onglet. |
| `Banner` | Bandeau d'information en tête de liste (rollover, backup, mise à jour). |

### 2.5 Animations et retours
- Transition d'onglet : glissement horizontal 250 ms ease-out (+ swipe gestuel).
- Complétion 100 % des tâches du jour : mini-confettis (`react-native-reanimated`, particules maison — pas de lib native) + haptique `success`.
- Son de complétion : "pop" court (< 0,3 s, asset embarqué), joué via `expo-audio`, précédé d'une initialisation au premier tap (politique iOS).
- Rebond léger (scale 0,97) au press des boutons.

---

## 3. Navigation et shell applicatif

- **Rail latéral gauche permanent** avec 5 onglets verticaux : Todo, Routine, Event, Checklist, Settings (ordre fixe) — la signature visuelle est conservée à l'identique sur desktop.
- Onglet actif mémorisé entre les sessions (store UI persisté).
- **Fenêtre** : taille min 420×700, taille/position mémorisées ; fermer (✕) = réduire au tray ; quitter = menu du tray uniquement.
- **Tray** : icône permanente ; clic gauche = afficher/masquer ; menu contextuel = Ouvrir · Ajouter une tâche · Quitter.
- **Raccourcis clavier** : `Ctrl+N` nouvelle tâche · `←/→` jour précédent/suivant · `Ctrl+T` aujourd'hui · `Ctrl+1..5` onglets · `Ctrl+K` recherche (V1.1) · `Ctrl+E` export.
- Clic sur une notification → fenêtre restaurée sur l'onglet et la date concernés.
- Démarrage à froid < 1,5 s (binaire natif, WebView2 préinstallée sur Windows 10/11).

---

## 4. Spécifications écran par écran

Convention : chaque écran est décrit avec ses **états** (nominal, vide, chargement, erreur) et ses **interactions**.

### 4.1 Écran Todo

**En-tête**
- Ligne 1 : mois + année (`juil. 2026`, caption). Ligne 2 : `6.lun.` en display + badge `TODAY` (contour info) si date du jour.
- Icônes droites : historique (liste des 30 derniers jours avec taux de complétion), objectifs (stats de la semaine), graphique (complétion 7/30 jours, barres).
- Icône "mode compact" : réduit la hauteur des lignes de 72 à 48 px, masque les heures. État persisté.

**Corps — ordre d'affichage**
1. Bannière rollover (si todos non terminés à traiter, §4.1.d).
2. Bannière backup (si dernier export > 7 j).
3. Événements du jour + countdowns actifs (`🎉 Anniversaire Maman` / `J-12 · Go-Live Miles`), non cochables, tap → fiche événement.
4. Routines du jour (icône, titre, heure), cochables.
5. Todos ponctuels, cochables.
- Tri : si `autoSortByTime` → heure croissante, tâches sans heure à la fin (ordre manuel conservé entre elles) ; sinon ordre manuel global (drag & drop par poignée en mode réorganisation, activé par appui long).

**Zone d'ajout (bas)**
- Champ `Ajouter` (fond `bg.secondary`). Validation clavier → création immédiate sur la date affichée ; selon `keyboardMode`, le clavier reste ouvert (saisie en rafale) ou se ferme.
- Syntaxe rapide : `8:30 Appeler banque` → heure détectée et extraite (regex `^\d{1,2}[:h]\d{2}\s`).
- FAB (+) : ouvre le BottomSheet complet (titre, date, heure, emoji, note, rappel on/off).

**Navigation temporelle**
- Boutons ‹ › dans l'en-tête + flèches clavier `←/→` : jour précédent/suivant (animation de glissement).
- Bouton "Aujourd'hui" (pill) : visible uniquement hors date du jour (`Ctrl+T`).

**États**
- Vide (aucune tâche) : illustration légère + "Rien de prévu. Ajoutez une tâche ou créez une routine."
- Chargement : squelettes de 3 lignes (rare, SQLite local).
- Jour passé : tâches non cochées grisées, coche possible (rattrapage) mais horodatée à `doneAt = now`.

**BottomSheet "Tâche" (création/édition)**
Champs : titre* · date (défaut = jour affiché) · heure (picker roue iOS) · emoji · note (multiligne 500 car.) · rappel (toggle, visible si permission accordée et heure définie). Actions : Enregistrer / Supprimer (édition) / glisser pour fermer (confirmation si champ modifié).

### 4.2 Écran Routine

- Titre `Routine` (display) + icône mode compact.
- Carte routine : emoji + titre + bouton `Éditer` (pill) · `DayDots` (jours actifs colorés `tab.routine`) · compteur `x/n` (n = jours actifs) · heure (si définie) avec icône horloge · cloche si rappel actif.
- Pill `Mensuel` (bas gauche) : bascule vers la vue mensuelle — grille calendaire, chaque jour coloré selon le taux de complétion des routines (0 % transparent → 100 % `tab.routine` plein), navigation par mois. Retour par le même bouton (`Liste`).
- FAB (+) : BottomSheet "Routine" — titre* · emoji · jours de la semaine* (min 1, toggle sur `DayDots`) · heure (optionnelle) · rappel (toggle, exige une heure) · Enregistrer / Supprimer / Archiver.
- État vide : "Gérez vos routines ici et cochez-les dans la liste de tâches." + flèche vers le FAB.
- Suppression : alerte de confirmation ; l'historique de complétions est conservé (soft delete → `archived`), les instances futures disparaissent de Todo.

### 4.3 Écran Event

- Titre `Event` + navigation par année `← 2026 →`.
- Liste groupée par mois : icône + titre + date + badge `Annuel` si récurrent + `J-x` si countdown actif. Tap → BottomSheet édition.
- Pill `Calendrier` : vue calendrier de l'année (12 mini-mois, points sur les dates à événement) ; tap sur un mois → zoom mensuel.
- Lien `DayCircle?` : explication de la fonction countdown.
- FAB (+) : BottomSheet "Événement" — titre* · date* (picker calendrier) · icône (enveloppe ✉️ / fête 🎉 / maison 🏠 / emoji libre) · répétition annuelle (toggle) · compte à rebours DayCircle (toggle) · notification jour J (toggle) · sync Apple Calendar (toggle, si permission).
- État vide (cf. capture) : "Des anniversaires ou événements à venir ?" + 3 icônes d'exemple + texte explicatif.

### 4.4 Écran Checklist

- Sélecteur de liste (pill `Colis ⌄` haut gauche) : ouvre un sheet listant les checklists + `Nouvelle liste`. Bouton `Réorganiser` (haut droite) : drag & drop des items.
- Titre de la liste (display) + icônes : mode compact, crayon (renommer la liste ; le sheet de renommage propose aussi `Supprimer la liste` avec confirmation).
- Items : `Checkbox` + titre (2 lignes max) ; cochés = barrés, conservés en bas ? **Non** — ils restent à leur position (fidèle aux captures), seul le style change.
- Champ d'ajout (fond `bg.secondary`) + FAB (+).
- Bouton `🗑 Supprimer les éléments sélectionnés` (contour) : visible si ≥ 1 item coché ; confirmation ; supprime les cochés de la liste courante.
- État vide : "Ajoutez vos premiers éléments — courses, colis, idées…"
- Une liste `List` est créée par défaut au premier lancement (renommable).

### 4.5 Écran Settings

Sections dans l'ordre, avec libellés FR définitifs :

1. **Sauvegarde** (carte mise en avant, remplace le bandeau "Note Plus") : dernier export (`il y a 3 jours` / `jamais` en rouge), boutons `Exporter mes données` / `Importer`, toggle `Export auto hebdomadaire`.
2. **Intégrations** : bouton `Exporter en ICS` (événements + routines, importable Outlook/Google).
3. **Donnez-nous votre avis** : 4 smileys → ouvre l'app Mail pré-remplie (optionnel, retirable).
4. **Todos non terminés** : radios `Ne gérer que celles d'hier` / `Gérer cette semaine` (défaut) / `Quitter` + texte d'aide.
5. **Langue** : `français` / `English` (lien à droite, sheet de sélection).
6. **Taille de police** : radios Petit / Moyen / Grand.
7. **Trier automatiquement les tâches par heure** : toggle + aide "Lorsque le tri automatique est activé, il est impossible de changer l'ordre manuellement."
8. **Effet sonore lors de la vérification** : toggle (défaut on).
9. **Commencer la semaine sur** : radios Dimanche / Lundi (défaut Lundi) → avertissement si des compteurs sont en cours (§6.2).
10. **Customize Tabs** : 3 lignes (Routine, Event, Checklist), pastille couleur → sheet palette 8 couleurs.
11. **Saisie de tâches** : radios `Garder le focus` (défaut — le champ reste actif après ajout, saisie en rafale) / `Libérer le focus`.
12. **Appearance** : radios Light (défaut) / Dark / Système.
13. **Rappels & système** : état de la permission notifications (`Autoriser` au premier usage) · toggle `Lancer au démarrage de Windows` (défaut on) · toggle `Réduire dans la barre système à la fermeture` (défaut on, avec avertissement si désactivé : les rappels ne fonctionneront plus fenêtre fermée).
14. **Zone danger** : `Supprimer toutes mes données` (rouge, §6.6).
15. Liens : Conditions générales, Politique de données (écrans statiques markdown), version de l'app + runtimeVersion (utile debug).

### 4.6 Premier lancement (onboarding)
- Détection : table `meta` vide → séquence de 3 écrans swipables (concept Todo/Routine, rappels, sauvegarde — insistance sur le risque Expo Go et l'export auto), bouton `Commencer`.
- Amorçage des données : checklist `List` vide, 2 routines d'exemple désactivables ("Faire mon lit" 8:00, "Boire de l'eau" 8:30, L→D), langue = locale du téléphone (fr si fr-*, sinon en).
- Aucune permission demandée pendant l'onboarding (principe §11).

---

## 5. User stories et priorisation MoSCoW

Format : `US-xx · [Priorité] · En tant qu'utilisateur…` + critères Given/When/Then principaux.

### Todo
- **US-01 · [M] Ajouter une tâche rapide.** Given l'écran Todo du 06/07, When je tape "Appeler la banque" et valide, Then la tâche apparaît en fin de liste, non cochée, datée du 06/07, et le clavier reste ouvert (mode "Garder").
- **US-02 · [M] Ajouter une tâche avec heure via syntaxe rapide.** Given le champ d'ajout, When je saisis "8:30 Sport", Then la tâche "Sport" est créée avec l'heure 08:30.
- **US-03 · [M] Cocher/décocher.** When je coche une tâche, Then coche animée + son + haptique + texte barré ; When je décoche, Then retour à l'état initial ; si c'est une instance de routine, le compteur hebdo est mis à jour dans les deux sens.
- **US-04 · [M] Naviguer entre les jours.** When je clique › ou presse `→`, Then j'affiche le 07/07 ; le bouton "Aujourd'hui" apparaît.
- **US-05 · [M] Rollover.** Given le mode "cette semaine" et 2 todos non cochés hier, When j'ouvre l'app pour la première fois aujourd'hui, Then une bannière liste ces todos avec, pour chacun : Déplacer à aujourd'hui / Laisser / Supprimer.
- **US-06 · [S] Réorganiser manuellement.** Given le tri auto désactivé, When je fais un appui long puis glisse une tâche, Then l'ordre est persisté.
- **US-07 · [S] Mode compact.** When j'active l'icône compacte, Then les lignes passent à 48 px et l'état est mémorisé.
- **US-08 · [C] Statistiques.** When j'ouvre l'icône graphique, Then je vois la complétion des 7 et 30 derniers jours.

### Routine
- **US-10 · [M] Créer une routine.** When je crée "Faire mon lit", jours L→D, 8:00, Then elle apparaît dans Routine avec 7 pastilles actives et 0/7, et dans Todo de chaque jour à 8:00.
- **US-11 · [M] Compteur hebdomadaire.** Given "Boire de l'eau" active L→D, When je coche lundi et mardi, Then le compteur affiche 2/7 ; le lundi suivant (début de semaine), il repart à 0/7 sans perdre l'historique.
- **US-12 · [M] Modifier les jours actifs.** Given une routine L-M-V, When je retire le vendredi, Then les instances futures du vendredi disparaissent de Todo, les complétions passées restent comptées dans l'historique.
- **US-13 · [M] Rappel de routine.** Given l'app au tray, When j'active le rappel d'une routine 8:00 L-V, Then une notification Windows se déclenche chaque jour ouvré à 8:00, fenêtre fermée ; le clic restaure la fenêtre sur le Todo du jour.
- **US-14 · [S] Vue mensuelle.** When j'ouvre "Mensuel", Then je vois la heatmap de complétion du mois courant.
- **US-15 · [C] Archiver.** When j'archive une routine, Then elle disparaît de partout sauf des statistiques passées.

### Event
- **US-20 · [M] Créer un événement annuel.** When je crée "Anniversaire Maman" le 15/09 récurrent, Then il apparaît dans Event 2026 et dans le Todo du 15/09 de chaque année.
- **US-21 · [M] Countdown DayCircle.** Given l'événement "Go-Live Miles" le 18/07 avec countdown, When j'ouvre le Todo du 06/07, Then "J-12 · Go-Live Miles" s'affiche en tête.
- **US-22 · [S] Tray & autostart.** Given le toggle autostart actif, When Windows démarre, Then l'app se lance réduite au tray ; When je ferme la fenêtre (✕), Then elle se réduit au tray sans quitter.
- **US-23 · [C] Export ICS.** When je touche "Exporter en ICS", Then un fichier .ics contenant tous les événements (RRULE annuelle si récurrent) s'ouvre dans la feuille de partage iOS.

### Checklist
- **US-30 · [M] Multi-listes.** When je crée la liste "Colis", Then elle est sélectionnable dans le pill et indépendante des dates.
- **US-31 · [M] Cocher sans supprimer.** When je coche "Sephora", Then l'item est barré et reste en place.
- **US-32 · [M] Purge des cochés.** Given 3 items cochés, When je touche "Supprimer les éléments sélectionnés" et confirme, Then ils sont supprimés de la liste courante uniquement.
- **US-33 · [S] Renommer/supprimer une liste.** Via l'icône crayon ; suppression avec confirmation et décompte des items.

### Settings & transverse
- **US-40 · [M] Export/import JSON.** Round-trip complet sans perte (test §18).
- **US-41 · [M] Dark mode.** Les 3 modes s'appliquent instantanément, y compris aux couleurs d'onglets assombries.
- **US-42 · [M] Début de semaine.** Le changement Dimanche/Lundi réordonne les DayDots et réinitialise la fenêtre des compteurs (avec avertissement).
- **US-43 · [S] i18n.** Bascule FR/EN instantanée, dates localisées.
- **US-44 · [S] Customize Tabs.** Changement de couleur appliqué immédiatement au rail et aux composants liés.
- **US-45 · [M] Wipe.** "Supprimer toutes mes données" exige la saisie de SUPPRIMER, propose un export préalable, puis vide la base et replanifie (annule) toutes les notifications.

**Récap MoSCoW** — Must : US-01→05, 10→13, 20, 21, 30→32, 40→42, 45. Should : US-06, 07, 14, 22, 33, 43, 44. Could : US-08, 15, 23. Won't (V1) : OCR (V1.1), push distant, sync cloud, version mobile.

---

## 6. Règles de gestion et cas limites

### 6.1 Dates et fuseaux
- Toute date métier est une **date locale** `YYYY-MM-DD` (jamais UTC, jamais de `Date` sérialisé brut). L'heure d'une tâche est un champ séparé `HH:mm`.
- "Aujourd'hui" est recalculé au focus de la fenêtre ET par le planificateur interne (tick minute, §10) : au passage de minuit — l'app tournant en permanence au tray — la liste Todo se rafraîchit et le rollover est réévalué à la prochaine ouverture de fenêtre.
- Voyage/changement de fuseau : les dates restent celles saisies (une tâche du 06/07 reste au 06/07). Les notifications programmées en trigger calendaire suivent l'heure locale du téléphone (comportement iOS standard) — documenté, pas de compensation.

### 6.2 Semaine et compteurs
- La "semaine courante" = [début de semaine ; début + 6 j], début = lundi ou dimanche selon réglage.
- Compteur de routine `x/n` : x = complétions datées dans la semaine courante ET sur un jour actif ; n = nombre de jours actifs.
- **Changement du réglage début de semaine en milieu de semaine** : recalcul immédiat des fenêtres → les compteurs peuvent changer de valeur. Alerte avant application : "Vos compteurs de la semaine seront recalculés."
- **Modification des jours actifs après des complétions** : les complétions passées hors nouveaux jours actifs restent stockées mais ne comptent plus dans `x` (recalcul pur, pas de mutation des données).

### 6.3 Rollover
- Évalué une fois par jour civil, au premier passage au premier plan. Fenêtre : hier (mode `yesterday`) ou [début de semaine ; hier] (mode `week`).
- Portent sur les **todos ponctuels non cochés** uniquement — jamais les instances de routines (une routine manquée est simplement non complétée) ni les événements.
- Déplacement : `date = today`, `originDate` conservé (affiché en caption "reporté du 03/07"), heure conservée.
- Un todo déjà reporté peut l'être à nouveau ; `originDate` garde la **première** date.

### 6.4 Récurrence des événements
- Événement annuel du **29/02** : les années non bissextiles, il s'affiche le **28/02** (règle explicite, testée).
- Countdown : `J-x` où x = différence en jours civils locaux ; `J-0` = affichage en tête avec l'icône fête ; après la date (non récurrent), l'événement reste consultable dans Event mais disparaît de Todo.
- Récurrent + countdown : le compte à rebours vise la **prochaine** occurrence.

### 6.5 Tri et réorganisation
- `autoSortByTime` on : ordre = heure croissante, puis sans-heure par `sortIndex`. Le drag & drop est désactivé (poignées masquées).
- `autoSortByTime` off : `sortIndex` global par date. À la création : `max(sortIndex)+1`. Les instances de routine sont injectées en tête des todos, ordonnées par heure.

### 6.6 Suppressions
- Tâche : suppression directe (undo via snackbar 5 s).
- Routine : soft delete (`archived=1`) — l'historique et les stats survivent ; ses notifications sont annulées.
- Liste de checklist : hard delete avec confirmation (« Supprimer "Colis" et ses 7 éléments ? »).
- Wipe global : saisie du mot `SUPPRIMER`, proposition d'export préalable, `DELETE` sur toutes les tables + `cancelAllScheduledNotificationsAsync()` + reset du store settings.

### 6.7 Divers
- Titre : 1–200 caractères, trim, emojis autorisés. Note : 500 max.
- Limite raisonnable non bloquante : avertissement de performance au-delà de 5 000 todos (jamais atteint en usage réel).
- Minuit pile : une tâche créée à 00:00 appartient au nouveau jour (date locale au moment de la validation).

---

## 7. Modèle de données

### 7.1 DDL SQLite (tauri-plugin-sql — fichier `%APPDATA%/com.jyn.circletasks/circletasks.db`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
); -- schemaVersion, installedAt, lastRolloverDate, lastExportAt

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,               -- uuid v4
  date TEXT NOT NULL,                -- 'YYYY-MM-DD' locale
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  time TEXT,                         -- 'HH:MM' ou NULL
  note TEXT,
  emoji TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,                      -- ISO datetime
  sort_index INTEGER NOT NULL,
  origin_date TEXT,                  -- si reporté
  source_routine_id TEXT,            -- NULL pour un todo ponctuel (voir note §7.3)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_date ON todos(date);
CREATE INDEX IF NOT EXISTS idx_todos_date_done ON todos(date, done);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  emoji TEXT,
  days TEXT NOT NULL,                -- JSON '[0,1,2,3,4]' ; 0 = premier jour de semaine configuré... NON: 0=lundi fixe, voir §7.3
  time TEXT,
  reminder INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routine_completions (
  routine_id TEXT NOT NULL REFERENCES routines(id),
  date TEXT NOT NULL,
  done_at TEXT NOT NULL,
  PRIMARY KEY (routine_id, date)
);
CREATE INDEX IF NOT EXISTS idx_rc_date ON routine_completions(date);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,                -- occurrence de référence
  icon TEXT NOT NULL DEFAULT 'party',
  yearly_repeat INTEGER NOT NULL DEFAULT 0,
  countdown INTEGER NOT NULL DEFAULT 0,
  notify_day INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checklists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  checklist_id TEXT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_list ON checklist_items(checklist_id);
```

### 7.2 Migrations
- `meta.schemaVersion` (entier). Au boot : exécution séquentielle des migrations `v(n)→v(n+1)` dans une transaction ; échec → rollback + écran d'erreur avec proposition d'export brut de la base (copie du fichier .db via expo-sharing).
- Chaque migration = fichier `db/migrations/00x_description.ts` exportant `up(db)`. Interdiction de modifier une migration publiée.

### 7.3 Conventions critiques (sources de bugs classiques)
- **Jours de semaine — UNE seule convention interne : ISO (1 = lundi … 7 = dimanche)** dans `routines.days`. Le réglage "début de semaine" n'affecte QUE l'affichage (ordre des DayDots, bornes de la semaine), jamais le stockage. Plus aucune conversion de convention nécessaire : le planificateur interne (§10) compare directement en ISO.
- **Les routines ne créent PAS de lignes `todos`** : instances calculées à la volée (routine active ce jour + éventuelle completion). `todos.source_routine_id` reste NULL en V1.
- **Rappels déjà émis** : table `meta`, clé `firedReminders` (JSON `{"routineId|todoId": "YYYY-MM-DD HH:mm"}` purgé quotidiennement) — garantit qu'un rappel n'est émis qu'une fois par occurrence (§10).
- Settings et état UI : hors SQLite, dans Zustand persisté via `localStorage` (WebView2).

### 7.4 Format d'export JSON
```json
{
  "app": "circletasks",
  "schemaVersion": 1,
  "exportedAt": "2026-07-06T12:00:00+02:00",
  "settings": { },
  "todos": [], "routines": [], "routineCompletions": [],
  "events": [], "checklists": [], "checklistItems": []
}
```
Import : validation Zod stricte → si `schemaVersion` importé < courant, application des transformations de migration en mémoire ; si > courant, refus explicite ("Sauvegarde issue d'une version plus récente"). Choix Fusionner (upsert par id) / Remplacer (wipe + insert), en transaction.

---

## 8. Fonctions pures critiques (signatures + cas de test)

Toutes dans `lib/`, sans dépendance à SQLite ni React — testées unitairement en priorité.

```typescript
// lib/week.ts
getWeekBounds(today: LocalDate, weekStartsOn: 'monday'|'sunday'): { start: LocalDate; end: LocalDate }
// tests: mercredi/lundi → [lun, dim] ; dimanche/dimanche → [dim, sam] ; changement de réglage recalcule.

// lib/routines.ts
isRoutineActiveOn(routine: Routine, date: LocalDate): boolean
weeklyCounter(routine: Routine, completions: LocalDate[], today: LocalDate, weekStartsOn): { done: number; total: number }
// tests: L-V complétée lun+mar un mercredi → 2/5 ; complétion samedi hors jours actifs → ignorée ;
// retrait d'un jour actif après complétion → x recalculé ; semaine suivante → 0/5.

// lib/rollover.ts
computeRollover(uncheckedTodos: Todo[], today: LocalDate, mode: 'yesterday'|'week'|'off', weekStartsOn): Todo[]
// tests: mode off → [] ; todo d'il y a 8 jours en mode week → exclu ; routine-instance → jamais incluse ;
// todo déjà reporté conserve son originDate initial.

// lib/events.ts
nextOccurrence(event: Event, today: LocalDate): LocalDate | null
countdownDays(event: Event, today: LocalDate): number | null
// tests: 29/02 en année non bissextile → 28/02 ; événement passé non récurrent → null ;
// récurrent : occurrence de l'année suivante si la date de cette année est passée ; J-0 le jour même.

// lib/sort.ts
sortDayItems(items: DayItem[], autoSortByTime: boolean): DayItem[]
// tests: heures croissantes ; sans-heure après horodatés ; stabilité de l'ordre manuel.

// lib/reminders.ts — planificateur desktop (§10)
dueReminders(now: LocalDateTime, routines: Routine[], todos: Todo[], events: Event[], fired: FiredMap): Reminder[]
// tests: routine L-V 8:00 due à 08:00 un mercredi, pas le samedi ; jamais deux fois la même occurrence (fired) ;
// rattrapage borné : due à 08:00, tick à 08:03 (PC sorti de veille) → émise ; à 08:20 → ignorée (fenêtre 15 min) ;
// todo coché avant l'heure → non émis ; event notify_day → une émission à 09:00 le jour J.

// lib/quickparse.ts
parseQuickAdd(input: string): { title: string; time?: string }
// tests: "8:30 Sport" → {Sport, 08:30} ; "18h05 Réunion" → {Réunion, 18:05} ; "Sport 8:30" → titre brut sans heure.
```

---

## 9. Architecture technique

### 9.1 Stack

| Couche | Choix | Note |
|---|---|---|
| Shell natif | **Tauri 2** (Rust minimal : tray, autostart, fenêtre) | Binaire ~10 Mo, WebView2 |
| Frontend | React 18 + TypeScript strict + **Vite** | |
| État | Zustand (+ persist `localStorage` pour settings/ui) | |
| Base | `tauri-plugin-sql` (SQLite) | Fichier dans AppData, WAL, transactions |
| Notifications | `tauri-plugin-notification` | Notifications Windows natives |
| Autostart | `tauri-plugin-autostart` | Toggle Settings §4.5.13 |
| Fichiers/dialogs | `tauri-plugin-dialog` + `tauri-plugin-fs` | Backup §12, import d'image OCR |
| Ouverture liens | `tauri-plugin-opener` | Liens légaux, dossier de backups |
| Styles | CSS modules + variables CSS (tokens §2) | Pas de Tailwind : thème light/dark par `data-theme` |
| Dates | date-fns + locale fr | |
| Drag & drop | `@dnd-kit/core` + `@dnd-kit/sortable` | Souris + clavier (accessibilité) |
| OCR (V1.1) | Tesseract.js (lazy) | 100 % local |
| Sons | Web Audio (asset embarqué) | |
| Validation | Zod | |
| i18n | i18next + react-i18next | |
| Tests | **Vitest** + Testing Library (jsdom) | Mêmes tests que v3, runner adapté |
| Lint | ESLint + Prettier | |

**Règle :** la logique métier reste 100 % TypeScript côté frontend ; le Rust (`src-tauri/`) se limite au shell (fenêtre, tray, plugins) et n'est modifié que par l'agent platform-engineer.

### 9.2 Arborescence
```
circletasks-win/
├── src/                       # Frontend React (Vite)
│   ├── app/                   # App.tsx, TabRail, routing par état (pas de router nécessaire)
│   ├── components/            # UI partagée (§2.4)
│   ├── features/{todo,routine,event,checklist,settings}/
│   ├── db/                    # client tauri-plugin-sql, migrations/, repositories/
│   ├── lib/                   # fonctions pures (REPRISES TELLES QUELLES de v3, déjà testées)
│   │                          # + reminders.ts (scheduler §10), ics.ts, backup.ts, sound.ts, ocr.ts
│   ├── stores/  ├── i18n/  └── theme/   # tokens en variables CSS
├── src-tauri/
│   ├── Cargo.toml  tauri.conf.json
│   ├── capabilities/default.json        # permissions plugins
│   ├── src/{main.rs, lib.rs}            # tray, close-to-tray, init plugins
│   └── icons/
└── docs/  .claude/  CLAUDE.md  PLAN.md
```

### 9.3 Flux de données
Identique v3 : composants → hooks feature → repositories/lib ; mutations → `emitDbChanged()` ; aucune requête SQL ni appel Tauri direct dans un composant.

### 9.4 Gestion des erreurs et observabilité
- ErrorBoundary racine : écran de secours + boutons `Redémarrer` et `Ouvrir le dossier des données` (opener vers AppData) — un crash ne bloque jamais l'accès au fichier .db.
- Boot défensif : ouverture DB/migrations en try/catch ; échec → écran d'erreur + chemin du .db affiché.
- Journal local : `lib/logger.ts` (ring buffer 200 entrées, localStorage) ; écran debug via 7 clics sur la version.
- Le planificateur (§10) est enveloppé : une exception dans un tick est loguée et n'arrête jamais la boucle.

---

## 10. Rappels — planificateur interne (remplace la planification iOS)

Windows n'offre pas de notifications programmées à l'avance côté OS pour ce type d'app : c'est **l'app résidente au tray qui planifie**. Zéro limite de 64, zéro replanification — le modèle est plus simple que sur iOS.

- **Boucle** : tick toutes les 30 s (`setInterval`, aligné sur la minute), y compris fenêtre masquée (le processus vit au tray).
- À chaque tick : `dueReminders(now, …)` (fonction pure §8) détermine ce qui est dû — routines actives ce jour à `HH:mm`, todos horodatés avec rappel non cochés, événements `notify_day` à 09:00.
- **Anti-doublon** : registre `firedReminders` (meta, §7.3) — une occurrence = une émission, même après redémarrage de l'app.
- **Sortie de veille/redémarrage PC** : fenêtre de rattrapage de 15 min (un rappel de 8:00 constaté à 8:07 est émis ; à 8:20 il est abandonné — testé §8).
- Émission : `tauri-plugin-notification` (titre = entité, corps = heure/contexte) ; clic → restauration de la fenêtre sur l'écran/date concernés.
- Todo coché ou supprimé avant l'heure → jamais émis (l'état est relu à chaque tick, rien à annuler).
- Passage de minuit détecté par la boucle → invalidation du "jour courant" (rafraîchissement §6.1).

## 11. Permissions et comportements système

| Sujet | Comportement |
|---|---|
| Notifications | `isPermissionGranted()` puis `requestPermission()` au premier toggle de rappel — jamais au premier lancement. Refus → toggles inactifs + aide "Autoriser CircleTasks dans Paramètres Windows > Notifications". |
| Autostart | Toggle Settings (défaut on) via plugin ; état relu à l'ouverture des Settings (l'utilisateur peut l'avoir changé côté Windows). |
| Fermer = tray | Défaut on. Si désactivé : avertissement explicite que les rappels cessent fenêtre fermée. |
| Instance unique | Une seule instance : relancer l'exe restaure la fenêtre existante (plugin single-instance). |

## 12. Sauvegarde et restauration

- **Le risque de perte a fondamentalement baissé** vs Expo Go : les données vivent dans un fichier SQLite standard sous `%APPDATA%`, qui survit aux mises à jour et désinstallations de navigateurs/outils. Le backup reste une bonne hygiène, plus une question de survie.
- Export manuel : JSON (§7.4) via dialog natif "Enregistrer sous" (`Ctrl+E`).
- Export auto hebdomadaire (toggle, défaut on) : silencieux dans `AppData/backups/` (rotation 8) + bouton "Ouvrir le dossier des sauvegardes".
- Rappel doux : mention en Settings si dernier export manuel > 30 jours (plus de bannière agressive).
- Import : dialog natif → validation Zod → prévisualisation → Fusionner/Remplacer, en transaction.
- Test round-trip obligatoire (§18).

## 13. Gestion des versions (fortement allégée vs v3)

Le verrou Expo Go a disparu — il reste l'hygiène standard :
1. Lockfile commité ; versions exactes (`--save-exact`) pour toutes les dépendances npm ; `Cargo.lock` commité.
2. Tauri et ses plugins épinglés en `2.x` mineur ; montée de version = branche dédiée + `npm run tauri build` + test manuel complet.
3. CI GitHub Actions : `tsc --noEmit` + Vitest bloquants ; build Tauri Windows sur tag.
4. Jamais de montée de version et de feature dans le même commit.

## 14. Workflow de développement et distribution

1. Dev : `npm run tauri dev` — hot reload Vite dans la fenêtre native.
2. Build : `npm run tauri build` → installeur **NSIS** `CircleTasks_1.0.0_x64-setup.exe` (cible `nsis`).
3. Installation : double-clic ; SmartScreen → "Informations complémentaires" → "Exécuter quand même" (app non signée, usage personnel).
4. Mise à jour : ré-exécuter le nouvel installeur (les données en AppData sont préservées). Auto-updater Tauri possible en V2 si besoin.
5. Après installation : l'app s'enregistre au démarrage de Windows (autostart) et vit au tray.

## 15. i18n et accessibilité

- i18next inchangé (fr défaut/en) ; aucune chaîne en dur (règle ESLint).
- Accessibilité desktop : navigation **clavier complète** (tab order logique, raccourcis §3, dnd-kit clavier), rôles/labels ARIA sur tous les interactifs, focus visible, contrastes AA sur les deux thèmes, `prefers-reduced-motion` respecté (confettis/springs → fondus).
- Taille de police : facteurs §2.2 via variable CSS racine.

## 16. Limitations, risques et parades

| Risque | Parade |
|---|---|
| SmartScreen à l'installation (non signé) | Documenté §14.3 ; signature de code envisageable plus tard (~70 €/an) si distribution |
| Rappels dépendants du processus au tray | Autostart on par défaut + avertissement si close-to-tray désactivé + rattrapage 15 min après veille |
| WebView2 absente (Windows anciens) | L'installeur NSIS Tauri l'embarque/l'installe automatiquement |
| Veille prolongée pendant un rappel | Fenêtre de rattrapage §10 ; au-delà, l'occurrence apparaît non cochée dans Todo (comportement voulu) |
| Un seul PC | Assumé (§1.4) ; les backups JSON permettent une migration manuelle |

## 17. Roadmap

| Version | Contenu | Estimation |
|---|---|---|
| **V1.0 (Must)** | 5 onglets complets, rollover, compteurs, rappels via planificateur + tray + autostart, backup manuel+auto, dark mode, i18n, raccourcis clavier, installeur NSIS | 2,5-3 semaines à temps partiel (logique métier déjà écrite et testée) |
| **V1.1 (Should/Could)** | Scan OCR (import image/coller), heatmap mensuelle, statistiques, export ICS, recherche `Ctrl+K`, undo généralisé | +1-2 semaines |
| **V2.0** | Auto-updater, raccourci global "quick add" système, éventuelle PWA compagnon lecture seule pour le téléphone | À évaluer |

## 18. Plan de test et critères d'acceptation

### 18.1 Automatisés
- Vitest : 100 % de `lib/` (§8) — les tests v3 sont repris tels quels + `dueReminders` (occurrence unique, fenêtre 15 min, jour actif).
- Intégration : repositories sur SQLite (better-sqlite3 en environnement de test), migrations, round-trip backup.
- Composants : Checkbox, QuickAdd, RolloverBanner, TabRail (Testing Library/jsdom).

### 18.2 Critères d'acceptation V1 (manuels, sur ton PC)
1. Installation via le .exe NSIS ; l'app démarre, s'enregistre au démarrage de Windows.
2. Fermer la fenêtre (✕) → l'app reste au tray ; clic tray → fenêtre restaurée sur son état.
3. Routine "L-V 8:00" avec rappel → notification Windows à 8:00 **fenêtre fermée** ; clic → Todo du jour. Redémarrage du PC avant 8:00 → la notification part quand même (autostart).
4. PC en veille à 8:00, réveil 8:05 → la notification part (rattrapage) ; réveil 9:00 → pas de notification, la routine apparaît non cochée.
5. Coche/décoche d'une instance de routine → compteur x/5 à jour ; son + animation.
6. 2 todos non cochés hier → bannière rollover au premier affichage du jour ; les 3 actions fonctionnent.
7. "8:30 Sport" dans le quick add → tâche à 08:30 ; `Ctrl+N`, `←/→`, `Ctrl+T`, `Ctrl+1..5` opérationnels.
8. Export JSON → suppression du fichier .db → import : restauration 100 % (ordre manuel et complétions inclus).
9. Événement 15/09 récurrent + countdown → "J-x" correct en tête de Todo ; 29/02 géré.
10. Changement Lundi→Dimanche : avertissement, DayDots réordonnées, compteurs recalculés.
11. Dark mode, langue, taille de police instantanés ; navigation 100 % clavier possible sur l'écran Todo.
12. `tsc --noEmit` + Vitest verts en CI ; `npm run tauri build` produit l'installeur sans erreur.

---

## Annexe A — Checklist de démarrage projet
1. Prérequis PC : Node 20+, Rust (`winget install Rustlang.Rustup` puis `rustup default stable`), WebView2 (préinstallée sur Win 10/11).
2. `sh bootstrap.sh` (ou `bootstrap.bat`) : installe les dépendances npm, vérifie tsc + Vitest.
3. `npm run tauri dev` : la fenêtre native s'ouvre avec le shell (rail + 5 onglets).
4. Développement : suivre PLAN.md — la couche `lib/` est déjà livrée testée ; commencer par les repositories.
5. `npm run tauri build` quand la Phase 7 est CONFORME.
