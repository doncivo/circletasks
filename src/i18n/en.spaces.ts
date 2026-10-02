import type { Messages } from './types';

/** Spaces and projects module texts in English (optional language): same shape as fr.spaces.ts, checked by typing. */
export const spacesEn: Messages['spaces'] = {
  all: 'All',
  filterLabel: 'Space filter',
  sectionTitle: 'SPACES AND CALENDARS',
  settingsRow: 'Spaces and projects',
  summaryItem: '{name} ({count})',
  summarySeparator: ' · ',
  title: 'Spaces and projects',
  back: 'Back',
  loadError: 'Unable to load spaces.',
  saveError: 'Unable to save this change.',
  spaceCaption: 'SPACE {number}',
  nameLabel: 'Name of space {number}',
  colorCaption: 'Colour',
  colorGroup: 'Colour of space {name}',
  nameEmpty: 'The name cannot be empty.',
  nameTooLong: 'The name must not exceed 30 characters.',
  nameTaken: 'This name is already used by the other space.',
  colors: {
    teal: 'Teal',
    violet: 'Violet',
    green: 'Green',
    blue: 'Blue',
    brick: 'Brick',
    ochre: 'Ochre',
    rose: 'Rose',
    plum: 'Plum',
  },
};
