/**
 * Textes du module Espaces et projets (M13, ES-01 à ES-08), en français : source de vérité ; `en.spaces.ts` suit la même forme.
 */
export const spacesFr = {
  all: 'Tout',
  filterLabel: 'Filtre d’espace',
  sectionTitle: 'ESPACES ET CALENDRIERS',
  settingsRow: 'Espaces et projets',
  summaryItem: '{name} ({count})',
  summarySeparator: ' · ',
  title: 'Espaces et projets',
  back: 'Retour',
  loadError: 'Impossible de charger les espaces.',
  saveError: 'Impossible d’enregistrer cette modification.',
  spaceCaption: 'ESPACE {number}',
  nameLabel: 'Nom de l’espace {number}',
  colorCaption: 'Couleur',
  colorGroup: 'Couleur de l’espace {name}',
  nameEmpty: 'Le nom ne peut pas être vide.',
  nameTooLong: 'Le nom ne doit pas dépasser 30 caractères.',
  nameTaken: 'Ce nom est déjà utilisé par l’autre espace.',
  addedIn: 'Ajouté dans {name}',
  colors: {
    teal: 'Bleu canard',
    violet: 'Violet',
    green: 'Vert',
    blue: 'Bleu',
    brick: 'Brique',
    ochre: 'Ocre',
    rose: 'Rose',
    plum: 'Prune',
  },
} as const;
