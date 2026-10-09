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
    // Autorisations de la dictée (I-05) : explication avant les fenêtres d’iOS, refus nommé et persistant, ouverture des Réglages.
    explain: {
      title: 'Dicter une tâche',
      text: 'CircleTasks écoute votre voix pour la transformer en texte, sur l’iPhone. Rien n’est enregistré ni envoyé. iOS vous demandera deux autorisations : le micro, puis la reconnaissance vocale.',
      continue: 'Continuer',
      later: 'Pas maintenant',
    },
    denied: {
      microphone: 'Le micro est refusé. Autorisez-le dans les Réglages de l’iPhone pour dicter.',
      speechRecognition: 'La reconnaissance vocale est refusée. Autorisez-la dans les Réglages de l’iPhone pour dicter.',
      microphoneRestricted: 'Le micro est restreint sur cet iPhone par Temps d’écran ou un profil de gestion. Seule la personne qui a posé la restriction peut la lever.',
      speechRecognitionRestricted: 'La reconnaissance vocale est restreinte sur cet iPhone par Temps d’écran ou un profil de gestion. Seule la personne qui a posé la restriction peut la lever.',
      openSettings: 'Ouvrir les réglages',
    },
    settingsFailed: 'Les réglages n’ont pas pu s’ouvrir. Ouvrez Réglages › CircleTasks.',
    onDeviceUnavailable: 'La dictée hors ligne en français n’est pas disponible sur cet iPhone. Activez la dictée dans Réglages › Général › Clavier › Dictée. Le micro du clavier reste utilisable.',
    pluginUnavailable: 'Dictée indisponible sur cet iPhone. Le micro du clavier reste utilisable.',
    nothingHeard: 'Rien n’a été entendu. Réessayez.',
    timeLimit: 'Dictée arrêtée après 60 s.',
    interrupted: 'Dictée interrompue.',
    busy: 'Une dictée est déjà en cours.',
    unavailable: 'La dictée n’est pas disponible pour le moment.',
    unknownState: 'L’état des autorisations n’a pas pu être lu.',
    code: 'Code : {code}',
  },
  // Messages « Annuler » des créations depuis la mini-fenêtre et le scan (Q-01, Q-04).
  undo: {
    created: '« {title} » ajoutée',
    createdMany: '{count} tâches créées',
  },
} as const;
