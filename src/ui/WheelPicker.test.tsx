import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WheelPicker, WHEEL_ITEM_HEIGHT, type WheelItem } from './WheelPicker';

const items: WheelItem[] = [
  { label: '—', spoken: 'Sans heure' },
  { label: '00', spoken: '0 heures' },
  { label: '01', spoken: '1 heures' },
  { label: '02', spoken: '2 heures' },
];

describe('WheelPicker (T-14, critère 6)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('est un spinbutton annoncé avec sa valeur en français', () => {
    render(<WheelPicker label="Heures" items={items} index={0} onChange={() => undefined} />);
    const wheel = screen.getByRole('spinbutton', { name: 'Heures' });
    expect(wheel).toHaveAttribute('aria-valuenow', '0');
    expect(wheel).toHaveAttribute('aria-valuemin', '0');
    expect(wheel).toHaveAttribute('aria-valuemax', '3');
    expect(wheel).toHaveAttribute('aria-valuetext', 'Sans heure');
    expect(wheel).toHaveAttribute('tabindex', '0');
  });

  it('se règle au clavier : flèches, Page, Début, Fin, avec bornes', () => {
    const onChange = vi.fn();
    const { rerender } = render(<WheelPicker label="Heures" items={items} index={1} onChange={onChange} pageStep={2} />);
    const wheel = screen.getByRole('spinbutton', { name: 'Heures' });
    fireEvent.keyDown(wheel, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(wheel, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(wheel, { key: 'PageUp' });
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(wheel, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(wheel, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(3);
    onChange.mockClear();
    rerender(<WheelPicker label="Heures" items={items} index={3} onChange={onChange} />);
    fireEvent.keyDown(wheel, { key: 'ArrowUp' });
    expect(onChange).not.toHaveBeenCalled(); // borne haute
    fireEvent.keyDown(wheel, { key: 'a' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('un élément touché devient le choix', () => {
    const onChange = vi.fn();
    render(<WheelPicker label="Heures" items={items} index={0} onChange={onChange} />);
    fireEvent.click(screen.getByText('02'));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it('le défilement se cale sur l’élément le plus proche une fois arrêté', () => {
    const onChange = vi.fn();
    render(<WheelPicker label="Heures" items={items} index={0} onChange={onChange} />);
    const viewport = screen.getByText('01').parentElement as HTMLElement;
    viewport.scrollTop = WHEEL_ITEM_HEIGHT * 2 + 5;
    fireEvent.scroll(viewport);
    expect(onChange).not.toHaveBeenCalled(); // attend la fin du défilement
    act(() => void vi.advanceTimersByTime(120));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('grisée : ni clavier, ni toucher, ni défilement, annoncée désactivée', () => {
    const onChange = vi.fn();
    render(<WheelPicker label="Minutes" items={items} index={0} onChange={onChange} disabled />);
    const wheel = screen.getByRole('spinbutton', { name: 'Minutes' });
    expect(wheel).toHaveAttribute('aria-disabled', 'true');
    expect(wheel).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(wheel, { key: 'ArrowUp' });
    fireEvent.click(screen.getByText('02'));
    const viewport = screen.getByText('01').parentElement as HTMLElement;
    viewport.scrollTop = WHEEL_ITEM_HEIGHT * 3;
    fireEvent.scroll(viewport);
    act(() => void vi.advanceTimersByTime(200));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('recale le défilement quand le choix change de l’extérieur', () => {
    const { rerender } = render(<WheelPicker label="Heures" items={items} index={0} onChange={() => undefined} />);
    const viewport = screen.getByText('01').parentElement as HTMLElement;
    rerender(<WheelPicker label="Heures" items={items} index={3} onChange={() => undefined} />);
    expect(viewport.scrollTop).toBe(WHEEL_ITEM_HEIGHT * 3);
  });
});

/** Roues longues (Q-05, revue I1) : rendu par fenêtre, premier calage à l'image suivante, fenêtre qui suit le défilement. Faux rAF, aucune horloge réelle. */
describe('WheelPicker : roue longue (rendu par fenêtre)', () => {
  const COUNT = 200;
  const INDEX = 100;
  const RADIUS = 40;
  const longItems: WheelItem[] = Array.from({ length: COUNT }, (_, i) => ({ label: `J${String(i)}`, spoken: `Jour ${String(i)}` }));
  let frames: (() => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(() => callback(0)));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames[id - 1] = () => undefined;
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const runFrames = (): void => {
    act(() => {
      const pending = frames;
      frames = [];
      for (const frame of pending) frame();
    });
  };
  const viewport = (): HTMLElement => document.querySelector('.ct-wheel__viewport') as HTMLElement;
  const rendered = (): number => viewport().querySelectorAll('.ct-wheel__item').length;
  /** Hauteur de la liste telle que la voit le défilement : éléments rendus et espaceurs. */
  const totalHeight = (): number =>
    ([...viewport().children] as HTMLElement[]).reduce((sum, child) => sum + (child.classList.contains('ct-wheel__item') ? WHEEL_ITEM_HEIGHT : Number.parseInt(child.style.height, 10)), 0);

  it('au montage : 81 éléments autour du choix et deux espaceurs qui gardent la hauteur de la liste complète', () => {
    render(<WheelPicker label="Jours" items={longItems} index={INDEX} onChange={() => undefined} />);
    expect(rendered()).toBe(2 * RADIUS + 1);
    const children = [...viewport().children] as HTMLElement[];
    expect(children).toHaveLength(2 * RADIUS + 3);
    expect(children[0]?.style.height).toBe(`${String((INDEX - RADIUS) * WHEEL_ITEM_HEIGHT)}px`);
    expect(children[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(children.at(-1)?.style.height).toBe(`${String((COUNT - 1 - (INDEX + RADIUS)) * WHEEL_ITEM_HEIGHT)}px`);
    expect(totalHeight()).toBe(COUNT * WHEEL_ITEM_HEIGHT);
  });

  it('la roue annonce le bon choix sur toute la plage, fenêtre ou non', () => {
    render(<WheelPicker label="Jours" items={longItems} index={INDEX} onChange={() => undefined} />);
    const wheel = screen.getByRole('spinbutton', { name: 'Jours' });
    expect(wheel).toHaveAttribute('aria-valuetext', 'Jour 100');
    expect(wheel).toHaveAttribute('aria-valuenow', '100');
    expect(wheel).toHaveAttribute('aria-valuemax', String(COUNT - 1));
    expect(wheel).toHaveAttribute('aria-valuemin', '0');
    expect(screen.getByText('J100')).toHaveAttribute('data-selected', 'true');
  });

  it('première image : le défilement est calé sur le choix (scrollTop final) ; la fenêtre reste la même, jamais la liste complète', () => {
    render(<WheelPicker label="Jours" items={longItems} index={INDEX} onChange={() => undefined} />);
    expect(viewport().scrollTop).toBe(0);
    runFrames();
    expect(viewport().scrollTop).toBe(INDEX * WHEEL_ITEM_HEIGHT);
    act(() => void vi.advanceTimersByTime(1000));
    expect(rendered()).toBe(2 * RADIUS + 1);
    expect(totalHeight()).toBe(COUNT * WHEEL_ITEM_HEIGHT);
  });

  it('un défilement du doigt avant la première image l’emporte sur le calage initial', () => {
    const onChange = vi.fn();
    render(<WheelPicker label="Jours" items={longItems} index={INDEX} onChange={onChange} />);
    viewport().scrollTop = 90 * WHEEL_ITEM_HEIGHT;
    fireEvent.scroll(viewport());
    runFrames();
    expect(viewport().scrollTop).toBe(90 * WHEEL_ITEM_HEIGHT);
    act(() => void vi.advanceTimersByTime(120));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(90);
  });

  it('la fenêtre suit le défilement : loin du centre elle se recentre, la hauteur totale ne change pas', () => {
    render(<WheelPicker label="Jours" items={longItems} index={INDEX} onChange={() => undefined} />);
    runFrames();
    // Petit écart : la fenêtre ne bouge pas.
    viewport().scrollTop = 105 * WHEEL_ITEM_HEIGHT;
    fireEvent.scroll(viewport());
    expect(screen.queryByText('J60')).toBeInTheDocument();
    // Grand écart : la fenêtre rejoint la position du doigt.
    viewport().scrollTop = 20 * WHEEL_ITEM_HEIGHT;
    fireEvent.scroll(viewport());
    expect(screen.getByText('J20')).toBeInTheDocument();
    expect(screen.getByText('J0')).toBeInTheDocument();
    expect(screen.queryByText('J100')).toBeNull();
    expect(rendered()).toBe(2 * RADIUS + 1);
    expect(totalHeight()).toBe(COUNT * WHEEL_ITEM_HEIGHT);
    expect(viewport().scrollTop).toBe(20 * WHEEL_ITEM_HEIGHT);
  });

  it('aux extrémités : fenêtre bornée à la liste, sans espaceur du côté du bord', () => {
    render(<WheelPicker label="Jours" items={longItems} index={0} onChange={() => undefined} />);
    const children = [...viewport().children] as HTMLElement[];
    expect(children[0]?.classList.contains('ct-wheel__item')).toBe(true);
    expect(rendered()).toBe(RADIUS + 1);
    expect(totalHeight()).toBe(COUNT * WHEEL_ITEM_HEIGHT);
  });

  it('un changement de choix venu de l’extérieur se cale aussitôt et la fenêtre le rejoint', () => {
    const { rerender } = render(<WheelPicker label="Jours" items={longItems} index={INDEX} onChange={() => undefined} />);
    rerender(<WheelPicker label="Jours" items={longItems} index={150} onChange={() => undefined} />);
    expect(viewport().scrollTop).toBe(150 * WHEEL_ITEM_HEIGHT);
    expect(screen.getByText('J150')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByRole('spinbutton', { name: 'Jours' })).toHaveAttribute('aria-valuetext', 'Jour 150');
    // L'image en attente ne ramène pas la roue à l'ancien choix.
    runFrames();
    expect(viewport().scrollTop).toBe(150 * WHEEL_ITEM_HEIGHT);
    expect(totalHeight()).toBe(COUNT * WHEEL_ITEM_HEIGHT);
  });

  it('démontage avant la première image : image annulée, aucune écriture tardive', () => {
    const { unmount } = render(<WheelPicker label="Jours" items={longItems} index={INDEX} onChange={() => undefined} />);
    unmount();
    expect(() => runFrames()).not.toThrow();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  it('une roue courte (moins de 100 éléments) est complète dès le montage, sans espaceur', () => {
    render(<WheelPicker label="Heures" items={items} index={1} onChange={() => undefined} />);
    expect(screen.getByText('02').parentElement?.children).toHaveLength(items.length);
  });
});
