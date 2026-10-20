import type { syncOwnDeletionFr } from './fr.syncOwnDeletion';

export const syncOwnDeletionEn: Record<keyof typeof syncOwnDeletionFr, string> = {
  orphan: 'Files from the previous epoch on this device could not be deleted: {cause}',
  own: 'Old files on this device could not be deleted: {cause}',
  lastTry: 'Last attempt at {time}',
  folder: 'Folder to check in Files: CircleTasks › devices › {device} › {epoch}',
  retry: 'Try again now',
};
