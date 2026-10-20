import type { notificationBodyFr } from './fr.notificationBody';

export const notificationBodyEn: { readonly [K in keyof typeof notificationBodyFr]: string } = {
  line: '{when} · {space}',
  dayTime: '{day} · {time}',
  shifted: '{line} · shifted',
  snoozed: 'Snoozed · {when}',
};
