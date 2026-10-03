/**
 * Textes du module Objectif de la semaine (M17, OB-01 à OB-06), en français : source de vérité ; `en.goals.ts` suit la même forme.
 */
export const goalsFr = {
  open: 'Objectif de la semaine',
  title: 'Objectif',
  back: 'Retour',
  panelLabel: 'Objectif de la semaine',
  panelCaption: 'OBJECTIF',
  weekLine: 'Semaine {number} · {range}',
  titleLabel: 'Objectif de la semaine',
  titleLabelN: 'Objectif de la semaine ({number})',
  titlePlaceholder: 'Mon objectif de la semaine',
  helpEmpty: 'Fixez ce qui compte cette semaine',
  addGoal: '+ Ajouter un objectif',
  iconButton: 'Icône de l’objectif',
  spaceLabel: 'Espace de l’objectif',
  deleteGoal: 'Supprimer l’objectif',
  deleteTitle: 'Supprimer l’objectif « {title} » ?',
  deleteDescription: 'Ses tâches rattachées restent, sans objectif.',
  deleteConfirm: 'Supprimer',
  loadError: 'Impossible de charger les objectifs.',
  saveError: 'Impossible d’enregistrer cet objectif.',
  titleTooLong: 'Le titre ne doit pas dépasser 200 caractères.',
  undo: {
    deleted: 'Objectif « {title} » supprimé',
  },
} as const;
