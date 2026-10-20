import { getLocale } from './index';
import { notificationPreviewsFr } from './fr.notificationPreviews';
import { notificationPreviewsEn } from './en.notificationPreviews';

export function tNotificationPreviews(key: keyof typeof notificationPreviewsFr): string {
  return (getLocale() === 'en' ? notificationPreviewsEn : notificationPreviewsFr)[key];
}
