import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSwipe } from './useSwipe';

/** S-03 critère 3 : balayage horizontal au toucher ; seuil de 30 % de la largeur ou vitesse suffisante, défilement vertical ignoré. */

function Zone({ onSwipe, disabled }: { onSwipe: (direction: 'left' | 'right') => void; disabled?: boolean }) {
  const handlers = useSwipe({ onSwipe, ...(disabled ? { disabled } : {}) });
  return <div data-testid="zone" {...handlers} />;
}

function setup(props: { disabled?: boolean } = {}) {
  const onSwipe = vi.fn();
  render(<Zone onSwipe={onSwipe} {...props} />);
  const zone = screen.getByTestId('zone');
  zone.getBoundingClientRect = () => ({ width: 400, height: 800, top: 0, left: 0, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  return { zone, onSwipe };
}

/** React remplace un `timeStamp` nul par l'heure courante : les instants simulés partent d'une base non nulle. */
const BASE = 1000;

function touch(zone: HTMLElement, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number, at: number, pointerType = 'touch'): void {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType }, timeStamp: { value: BASE + at } });
  fireEvent(zone, event);
}

afterEach(cleanup);

describe('useSwipe (S-03)', () => {
  it('un balayage lent d’au moins 30 % de la largeur change de semaine : vers la gauche, suivante', () => {
    const { zone, onSwipe } = setup();
    touch(zone, 'pointerdown', 350, 400, 0);
    touch(zone, 'pointermove', 200, 405, 800);
    touch(zone, 'pointerup', 200, 405, 3000);
    expect(onSwipe).toHaveBeenCalledWith('left');
  });

  it('un geste court mais rapide (40 px à plus de 0,5 px/ms) suffit', () => {
    const { zone, onSwipe } = setup();
    touch(zone, 'pointerdown', 200, 400, 0);
    touch(zone, 'pointerup', 150, 400, 60);
    expect(onSwipe).toHaveBeenCalledWith('left');
  });

  it('vers la droite, précédente', () => {
    const { zone, onSwipe } = setup();
    touch(zone, 'pointerdown', 40, 400, 0);
    touch(zone, 'pointerup', 300, 400, 100);
    expect(onSwipe).toHaveBeenCalledWith('right');
  });

  it('un geste trop court et trop lent ne fait rien', () => {
    const { zone, onSwipe } = setup();
    touch(zone, 'pointerdown', 200, 400, 0);
    touch(zone, 'pointerup', 150, 400, 400);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('un défilement vertical, même long, ne change pas de semaine', () => {
    const { zone, onSwipe } = setup();
    touch(zone, 'pointerdown', 200, 700, 0);
    touch(zone, 'pointermove', 230, 300, 100);
    touch(zone, 'pointerup', 260, 100, 200);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('une diagonale à dominante verticale ne compte pas non plus', () => {
    const { zone, onSwipe } = setup();
    touch(zone, 'pointerdown', 350, 100, 0);
    touch(zone, 'pointerup', 150, 500, 10);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('l’annulation du pointeur (le navigateur prend le défilement) abandonne le geste', () => {
    const { zone, onSwipe } = setup();
    touch(zone, 'pointerdown', 350, 400, 0);
    touch(zone, 'pointercancel', 350, 400, 10);
    touch(zone, 'pointerup', 100, 400, 20);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('la souris ne balaie pas', () => {
    const { zone, onSwipe } = setup();
    touch(zone, 'pointerdown', 350, 400, 0, 'mouse');
    touch(zone, 'pointerup', 50, 400, 10, 'mouse');
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('désactivé (carte tenue pour un glisser) : aucun balayage', () => {
    const { zone, onSwipe } = setup({ disabled: true });
    touch(zone, 'pointerdown', 350, 400, 0);
    touch(zone, 'pointermove', 200, 400, 10);
    touch(zone, 'pointerup', 50, 400, 20);
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
