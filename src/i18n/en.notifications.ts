import type { Messages } from './types';

/** English texts of reminder notifications and reminder status (N-01); same shape as `fr.notifications.ts`, checked by typing. */
export const notificationsEn: Messages['notifications'] = {
  untitled: 'Untitled',
  body: {
    atTime: 'Now',
    inAdvance: 'In {advance}',
  },
  advance: {
    week: '1 week',
  },
  recap: {
    more: 'and {n} more',
    morningTitle: 'Morning recap',
    eveningTitle: 'Evening recap',
    generic: 'Open CircleTasks to see your day',
  },
  focusEnd: {
    title: 'Session finished · {duration}',
  },
};

export const remindersStatusEn: Messages['reminders']['status'] = {
  sectionTitle: 'Reminder status',
  pcInfo: 'Reminders are sent by the iPhone',
  neverPlanned: 'Nothing scheduled yet',
  allowExplain: 'CircleTasks sends your reminders and recaps as notifications on this iPhone.',
  allow: 'Allow',
  allowLabel: 'Allow notifications',
  allowButton: 'Allow notifications',
  viewLabel: 'See the reminders problem',
  troubleGeneric: 'Reminders cannot be sent',
  permissionDeniedBanner: 'Notifications are denied: reminders will not ring',
  permissionDenied: 'Notifications are denied: reminders will not ring. Allow them in Settings > Notifications > CircleTasks on the iPhone.',
  permissionUndetermined: 'Allow notifications to receive your reminders',
  unavailable: 'Notifications are not available on this iPhone',
  planFailed: 'Reminders could not be scheduled',
  planFailedAt: 'Last attempt at {time} · code {code}',
  planFailedPartial: '{scheduled} scheduled, {cancelled} cancelled, {kept} kept',
  focusEndFailed: 'The end-of-session notification could not be scheduled',
  zoneUnknown: 'Device time zone unreadable: reminders computed with the current offset',
  zoneChanged: 'Time zone changed: reminders recomputed at {time}',
  ledgerRebuilt: 'Reminder register rebuilt at {time}',
  zoneLimit: 'After a time zone change, open CircleTasks: reminders are recomputed on opening.',
  warnStale: 'The iPhone has not synced for over 2 h: this reminder may not ring on time',
  warnNoIphone: 'No iPhone paired: this reminder will not ring',
  summaryStaleOne: 'The iPhone has not synced for over 2 h: 1 reminder in the next 2 hours may not ring on time',
  summaryStaleMany: 'The iPhone has not synced for over 2 h: {n} reminders in the next 2 hours may not ring on time',
  summaryNoIphoneOne: 'No iPhone paired: 1 reminder in the next 2 hours will not ring',
  summaryNoIphoneMany: 'No iPhone paired: {n} reminders in the next 2 hours will not ring',
};
