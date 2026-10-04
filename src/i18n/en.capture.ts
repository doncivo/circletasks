import type { Messages } from './types';

/** Quick capture texts in English (optional language, PRD section 8): same shape as fr.capture.ts, checked by typing. */
export const captureEn: Messages['capture'] = {
  suggestionsLabel: 'Suggestions',
  spaceOptionLabel: 'Space {name}',
  projectOptionLabel: 'Project {name}',
  projectOptionLabelIn: 'Project {name}, space {space}',
  previewLabel: 'What will be applied',
  removeToken: 'Remove {label}',
  spaceAnnounce: 'Space {space}',
  projectAnnounce: 'Project {project}',
  spaceProjectAnnounce: 'Space {space}, project {project}',
  dateAnnounce: 'Detected date: {label}',
  unknownProject: 'Unknown project in {space}',
  today: 'today',
  tomorrow: 'tomorrow',
  dateAndTime: '{date} · {time}',
  spaceAndProject: '{space} · {project}',
};
