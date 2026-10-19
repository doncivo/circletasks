import { getLocale } from './index';
import { syncOwnDeletionFr } from './fr.syncOwnDeletion';
import { syncOwnDeletionEn } from './en.syncOwnDeletion';

/** Catalogue chargé avec la ligne d'échec, jamais au départ. */
export function tOwnDeletion(key: keyof typeof syncOwnDeletionFr, args: Readonly<Record<string, string>> = {}): string {
  return (getLocale() === 'en' ? syncOwnDeletionEn : syncOwnDeletionFr)[key].replace(/\{(\w+)\}/g, (_, name: string) => args[name] ?? '');
}
