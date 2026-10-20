import type { notificationPreviewsFr } from './fr.notificationPreviews';

export const notificationPreviewsEn: { readonly [K in keyof typeof notificationPreviewsFr]: string } = {
  task: 'CircleTasks reminder: unlock to see the task',
  routine: 'CircleTasks reminder: unlock to see the routine',
  event: 'CircleTasks reminder: unlock to see the event',
  previewsHelp: 'On the lock screen, iOS hides the content of reminders until the iPhone is unlocked. To see the reminder title: iOS Settings › Notifications › CircleTasks › Show Previews › Always.',
};
