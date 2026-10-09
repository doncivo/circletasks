import type { syncVersionFr } from './fr.syncVersion';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.version` texts (Y-07), English. Same shape as `fr.syncVersion.ts`. */
export const syncVersionEn: Shape<typeof syncVersionFr> = {
  banner: 'Update the app: one of your devices uses a newer version',
  section: 'VERSION',
  newer: '{device} uses a newer version of the app',
  newerWithVersion: '{device} uses a newer version of the app ({version})',
  unknownVersion: 'unknown version',
  readSuspended: 'Reading its data is paused: update the app',
  failedLineOne: '1 item received from a newer version could not be integrated',
  failedLineMany: '{count} items received from a newer version could not be integrated',
  failedDetail: '{count} items not integrated ({kinds})',
  failedDetailOne: '1 item not integrated ({kinds})',
  failedLastTry: 'Last try: {time}',
  failedRetry: 'The app tries again at every start',
  failedBanner: 'Some received items could not be integrated: see Settings › Sync',
  kinds: {
    space: 'spaces',
    project: 'projects',
    recurrence: 'repeats',
    goal: 'goals',
    task: 'tasks',
    routine: 'routines',
    routineLog: 'routine days',
    routinePause: 'routine pauses',
    reminder: 'reminders',
    event: 'events',
    checklist: 'checklists',
    checklistItem: 'checklist items',
    focusSession: 'Focus sessions',
    calendarAccount: 'calendar accounts',
    holiday: 'holidays',
    settings: 'settings',
    other: 'other items',
  },
};
