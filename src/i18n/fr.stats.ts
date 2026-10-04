/**
 * Textes des statistiques (M11, H-01 à H-03), en français : source de vérité ; `en.stats.ts` suit la même forme.
 */
export const statsFr = {
  // --- rapport du mois (Rapport.html) ---
  caption: 'Rapport du mois',
  previousMonth: 'Mois précédent',
  nextMonth: 'Mois suivant',
  monthAnnouncement: 'Rapport de {month}',
  loadError: 'Impossible de charger le rapport du mois.',
  emptyTitle: 'Rien à compter en {month}.',
  // --- tuiles ---
  tilesLabel: 'Chiffres du mois',
  tasksLabel: 'TÂCHES FAITES',
  tasksOf: '/ {total}',
  tasksAria: 'Tâches faites : {done} sur {total}',
  tasksNone: 'Tâches faites : aucune tâche',
  routinesLabel: 'ROUTINES',
  routinesAria: 'Routines : {percent} %',
  routinesNone: 'Routines : aucune occurrence prévue',
  focusLabel: 'FOCUS',
  focusAria: 'Focus : {duration}',
  goalsLabel: 'OBJECTIFS',
  goalsOf: '/ {total} atteints',
  goalsAria: 'Objectifs : {achieved} atteints sur {total}',
  goalsNone: 'Objectifs : aucun objectif',
  noValue: '—',
  // --- graphique de complétion (H-02) ---
  chartSection: 'TAUX DE COMPLÉTION PAR SEMAINE',
  chartMonthRate: 'Mois : {percent} %',
  chartMonthRateNone: 'Mois : —',
  chartLabel: 'Taux de complétion par semaine',
  chartWeek: 'S{week}',
  chartTooltip: 'S{week} · {range} · {done} sur {total}',
  chartTooltipNone: 'S{week} · {range} · aucune tâche',
  chartTableLabel: 'Taux de complétion par semaine, en tableau',
  chartTableRow: 'Semaine {week} : {percent} %, {done} tâches sur {total}',
  chartTableRowFew: 'Semaine {week} : {percent} %, {done} tâche sur {total}',
  chartTableRowNone: 'Semaine {week} : aucune tâche',
  chartLoading: 'Chargement du graphique',
  chartError: 'Impossible d’afficher le graphique.',
} as const;
