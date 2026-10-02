/**
 * Catalogue d'emoji embarqué pour `EmojiPicker` (T-03, sous-tâche 1) : « liste
 * embarquée, aucun chargement réseau » (fiche T-03). Liste volontairement limitée
 * (planification personnelle, pas un clavier emoji complet) ; chaque entrée porte
 * la clé i18n de son libellé accessible, composé en `EmojiPicker` avec
 * `icons.emojiLabel` (« Emoji téléphone »).
 */
import type { PlainMessageKey } from '../i18n';

export interface EmojiCatalogEntry {
  readonly value: string;
  readonly nameKey: PlainMessageKey;
}

export const EMOJI_CATALOG: readonly EmojiCatalogEntry[] = [
  { value: '📞', nameKey: 'icons.emojiPhone' },
  { value: '💧', nameKey: 'icons.emojiWater' },
  { value: '📄', nameKey: 'icons.emojiDocument' },
  { value: '📅', nameKey: 'icons.emojiCalendar' },
  { value: '🏋️', nameKey: 'icons.emojiSport' },
  { value: '📖', nameKey: 'icons.emojiBook' },
  { value: '🛏️', nameKey: 'icons.emojiBed' },
  { value: '🧺', nameKey: 'icons.emojiBasket' },
  { value: '💰', nameKey: 'icons.emojiMoney' },
  { value: '✈️', nameKey: 'icons.emojiPlane' },
  { value: '❤️', nameKey: 'icons.emojiHeart' },
  { value: '🎉', nameKey: 'icons.emojiParty' },
  { value: '🎯', nameKey: 'icons.emojiTarget' },
  { value: '📧', nameKey: 'icons.emojiMail' },
  { value: '🐶', nameKey: 'icons.emojiDog' },
  { value: '🐱', nameKey: 'icons.emojiCat' },
  { value: '⏰', nameKey: 'icons.emojiAlarm' },
  { value: '🎵', nameKey: 'icons.emojiMusic' },
];
