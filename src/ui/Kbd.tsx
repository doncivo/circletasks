import { t, type PlainMessageKey } from '../i18n';
import './Kbd.css';

/** Traduction des jetons spéciaux du registre de raccourcis (src/features/app/shortcuts.ts). */
const TOKEN_KEYS: Readonly<Record<string, PlainMessageKey>> = {
  Ctrl: 'keyboard.ctrl',
  Alt: 'keyboard.alt',
  Shift: 'keyboard.shift',
  Space: 'keyboard.space',
  Escape: 'keyboard.escape',
  Enter: 'keyboard.enter',
  Delete: 'keyboard.delete',
  ArrowUp: 'keyboard.arrowUp',
  ArrowDown: 'keyboard.arrowDown',
  ArrowLeft: 'keyboard.arrowLeft',
  ArrowRight: 'keyboard.arrowRight',
};

/** Libellé d'un jeton du registre (Maj, Suppr, ←…) ; les lettres, chiffres et symboles restent tels quels. */
export function tokenLabel(token: string): string {
  const key = TOKEN_KEYS[token];
  return key ? t(key) : token;
}

export interface KbdProps {
  /** Combinaison au format du registre, ex. 'Ctrl+Shift+D', 'Alt+1' (src/features/app/shortcuts.ts). */
  keys: string;
  /** Séparateur affiché entre les touches ; '+' par défaut (« Ctrl+Maj+D »). */
  separator?: string;
  className?: string;
}

/**
 * Affiche une combinaison de touches, localisée (Maj/Shift…).
 *
 * @example
 * <Kbd keys="Ctrl+Shift+D" /> // « Ctrl+Maj+D » en français
 */
export function Kbd({ keys, separator = '+', className }: KbdProps) {
  const label = keys.split('+').map(tokenLabel).join(separator);
  return (
    <kbd className={['ct-kbd', className].filter(Boolean).join(' ')}>{label}</kbd>
  );
}
