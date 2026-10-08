import { fireEvent } from '@testing-library/react';

/**
 * Aides des tests de gestes de ligne (A-07) : événements de pointeur tactile, largeur de ligne fixée (jsdom ne mesure rien).
 * Jamais importé par le code livré.
 */
const BASE = 1000;

export function touch(target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number, at: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'touch' }, timeStamp: { value: BASE + at } });
  fireEvent(target, event);
}

/** Ligne `SwipeRow` d'un identifiant de ligne, avec une largeur de 400 px. */
export function swipeRowOf(rowId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-swipe-row="${rowId}"]`);
  if (!row) throw new Error(`ligne ${rowId} introuvable`);
  row.getBoundingClientRect = () => ({ width: 400, height: 66, top: 0, left: 0, right: 400, bottom: 66, x: 0, y: 0, toJSON: () => ({}) });
  return row;
}

/** Balayage lent vers la droite jusqu'à 55 % de la largeur, puis lâcher. */
export function swipeRight(row: HTMLElement): void {
  touch(row, 'pointerdown', 20, 30, 0);
  touch(row, 'pointermove', 140, 31, 300);
  touch(row, 'pointermove', 240, 31, 600);
  touch(row, 'pointerup', 240, 31, 700);
}

/** Balayage vers la gauche de 120 px (au-delà des 62 px d'ouverture), puis lâcher ; avale le clic synthétique qui suit. */
export function swipeLeft(row: HTMLElement): void {
  touch(row, 'pointerdown', 300, 30, 0);
  touch(row, 'pointermove', 240, 30, 300);
  touch(row, 'pointermove', 180, 30, 600);
  touch(row, 'pointerup', 180, 30, 700);
  fireEvent.click(row);
}
