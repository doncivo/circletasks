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
