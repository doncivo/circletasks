# Parcours clés (PRD section 8)

Chaque parcours s'exécute sur les projets Playwright `pc` et `iphone`.

| # | Parcours | Spec | Ordre |
|---|----------|------|-------|
| 1 | Premier lancement | `J01-premier-lancement.spec.ts` | 3 (P-05) ; couvert ; ES-01 couvert par `ES-01.spec.ts` |
| 2 | Tâche PC, rappel reçu sur l'iPhone | à écrire | 5 (rappels sur l'iPhone, N-01, N-03) avec la synchro de l'ordre 4 |
| 3 | Planifier la semaine | `J03-planifier-la-semaine.spec.ts` | 1 |
| 4 | Routine 3 fois par semaine | `J04-routine-trois-par-semaine.spec.ts` | 1 |
| 5 | Tâche mensuelle récurrente | `J05-tache-mensuelle.spec.ts` | 1 |
| 6 | Pro / Perso / Tout | `J06-pro-perso-tout.spec.ts` (Aujourd'hui, Semaine, puis rapport du mois) | 1 ; Statistiques à l'ordre 3 (ES-08, H-01) ; couvert |
| 7 | Capture rapide et scan | `J07-capture-et-scan.spec.ts` | 3 (Q-02, Q-04, Q-06) ; couvert avec le faux moteur OCR ; scan réel Vision à l'ordre 5 |
| 8 | Google Calendar | `J08-google-calendar.spec.ts` | 2 (M8, K-01, K-04) ; couvert |
| 9 | Recherche | `J09-recherche.spec.ts` | 2 (M14, RC-01 à RC-03) ; couvert |
| 10 | Conflit hors ligne | à écrire | 4 (Y-02, Y-04, Y-05) |
| 11 | Association QR et iCloud | à écrire | 4 (P-05, Y-01, Y-06, Y-08) |
| 12 | Objectif, « Un jour », glisser | `../J12-complet.spec.ts` | 1 |
