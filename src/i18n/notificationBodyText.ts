import { getLocale } from './index';
import { notificationBodyFr } from './fr.notificationBody';
import { notificationBodyEn } from './en.notificationBody';

export function tNotificationBody(key: keyof typeof notificationBodyFr, args: Readonly<Record<string, string>>): string {
  return (getLocale() === 'en' ? notificationBodyEn : notificationBodyFr)[key].replace(/\{(\w+)\}/g, (_, name: string) => args[name] ?? '');
}
