/**
 * Textes des gestes de ligne sur iPhone (A-07), en français : source de vérité ; `en.gestures.ts` suit la même forme.
 * Les noms accessibles des boutons (VoiceOver) sont « {action} : {title} » ; le groupe est « Actions : {title} ».
 */
export const gesturesFr = {
  actionsGroup: 'Actions : {title}',
  complete: 'Terminer',
  reopen: 'Rouvrir',
  postpone: 'Reporter',
  someday: 'Un jour',
  delete: 'Supprimer',
  today: 'Aujourd’hui',
  tomorrow: 'Demain',
  pickDate: 'Date…',
  actionLabel: '{action} : {title}',
  planTodayLabel: 'Planifier aujourd’hui : {title}',
  planTomorrowLabel: 'Planifier demain : {title}',
  pickDateLabel: 'Choisir une date pour : {title}',
} as const;
