/**
 * Textes de la capture rapide (M9, Q-06 et Q-02), en français : source de vérité ; `en.capture.ts` suit la même forme.
 */
export const captureFr = {
  suggestionsLabel: 'Suggestions',
  spaceOptionLabel: 'Espace {name}',
  projectOptionLabel: 'Projet {name}',
  projectOptionLabelIn: 'Projet {name}, espace {space}',
  previewLabel: 'Ce qui sera appliqué',
  removeToken: 'Retirer {label}',
  // Feuille « Nouvelle tâche » de l'iPhone (Q-05) : base occupée ou création refusée, texte conservé.
  sheetNotReady: 'La base n’est pas prête. Votre texte est conservé ; il ne peut pas être modifié pendant l’attente. Touchez « Réessayer » pour relancer l’enregistrement.',
  sheetRetry: 'Réessayer',
  // Écriture qui se termine après la fermeture de la feuille, ou doublon possible après « Réessayer » : jamais de fin muette.
  lateSaved: 'La tâche « {title} » a été enregistrée après la fermeture de la feuille.',
  lateFailed: 'La tâche « {title} » n’a pas pu être enregistrée. Touchez « + » pour la saisir de nouveau.',
  lateTwice: 'La tâche « {title} » a peut-être été enregistrée deux fois. Vérifiez votre liste.',
  sheetSaveError: 'La tâche n’a pas pu être enregistrée. Votre texte est conservé.',
  spaceAnnounce: 'Espace {space}',
  projectAnnounce: 'Projet {project}',
  spaceProjectAnnounce: 'Espace {space}, projet {project}',
  dateAnnounce: 'Date détectée : {label}',
  unknownProject: 'Projet inconnu dans {space}',
  today: 'aujourd’hui',
  tomorrow: 'demain',
  dateAndTime: '{date} · {time}',
  spaceAndProject: '{space} · {project}',
  // Mini-fenêtre de capture rapide (Q-01).
  window: {
    label: 'Capture rapide',
    heading: 'CAPTURE RAPIDE',
    placeholder: 'Ajouter une tâche — ex. « Appeler Paul demain 10h »',
    help: 'Entrée pour ajouter · Ctrl+Entrée pour enchaîner · Échap pour fermer',
    added: 'Ajoutée : {title}',
    titleEmpty: 'Saisissez un titre.',
    failed: 'Impossible d’ajouter la tâche.',
    noSpace: 'Aucun espace disponible.',
    sending: 'Ajout en cours…',
  },
  // Dictée (Q-03).
  dictation: {
    button: 'Dicter',
    helpPc: 'Appuyez sur Win + H pour dicter, parlez, puis relisez avant d’ajouter',
    listening: 'Je vous écoute',
    finish: 'Terminer',
    permissionDenied: 'Autorisez le micro dans les Réglages de l’iPhone',
    failed: 'La dictée n’a pas abouti. Réessayez ou utilisez le micro du clavier.',
  },
  // Messages « Annuler » des créations depuis la mini-fenêtre et le scan (Q-01, Q-04).
  undo: {
    created: '« {title} » ajoutée',
    createdMany: '{count} tâches créées',
  },
} as const;
