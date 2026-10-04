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
  window: {
    label: 'Quick capture',
    heading: 'QUICK CAPTURE',
    placeholder: 'Add a task — e.g. “Call Paul tomorrow 10am”',
    help: 'Enter to add · Ctrl+Enter to add another · Esc to close',
    added: 'Added: {title}',
    titleEmpty: 'Enter a title.',
    failed: 'Could not add the task.',
    noSpace: 'No space available.',
    sending: 'Adding…',
  },
  dictation: {
    button: 'Dictate',
    helpPc: 'Press Win + H to dictate, speak, then review before adding',
    listening: 'I’m listening',
    finish: 'Done',
    permissionDenied: 'Allow the microphone in the iPhone Settings',
    failed: 'Dictation did not work. Try again or use the keyboard microphone.',
  },
  undo: {
    created: '“{title}” added',
    createdMany: '{count} tasks created',
  },
};
