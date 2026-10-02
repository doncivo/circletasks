import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './Toast';

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('affiche le message et un rôle status', () => {
    render(<Toast message="Tâche reportée" onAction={() => undefined} />);
    expect(screen.getByRole('status')).toHaveTextContent('Tâche reportée');
  });

  it('propose le bouton « Annuler » par défaut', () => {
    render(<Toast message="Tâche reportée" onAction={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Annuler' })).toBeInTheDocument();
  });

  it('appelle onAction au clic', () => {
    const onAction = vi.fn();
    render(<Toast message="Tâche reportée" onAction={onAction} />);
    screen.getByRole('button', { name: 'Annuler' }).click();
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('appelle onTimeout après 5 s par défaut', () => {
    const onTimeout = vi.fn();
    render(<Toast message="Tâche reportée" onAction={() => undefined} onTimeout={onTimeout} />);
    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('relance le compte à rebours quand resetKey change', () => {
    const onTimeout = vi.fn();
    const { rerender } = render(<Toast message="Tâche reportée" onAction={() => undefined} onTimeout={onTimeout} resetKey={1} />);
    vi.advanceTimersByTime(4000);
    rerender(<Toast message="Tâche reportée" onAction={() => undefined} onTimeout={onTimeout} resetKey={2} />);
    vi.advanceTimersByTime(4000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('sans onAction : pas de bouton (message seul, ex. action impossible à annuler)', () => {
    render(<Toast message="Action impossible à annuler" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('le délai est suspendu pendant le survol puis reprend avec le temps restant (T-13 critère 9)', () => {
    const onTimeout = vi.fn();
    render(<Toast message="Tâche reportée" onAction={() => undefined} onTimeout={onTimeout} />);
    const toast = screen.getByRole('status');
    act(() => void vi.advanceTimersByTime(3000));
    fireEvent.mouseEnter(toast);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(onTimeout).not.toHaveBeenCalled();
    fireEvent.mouseLeave(toast);
    act(() => void vi.advanceTimersByTime(1999));
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('le délai est suspendu tant que le focus est dans le bandeau (clavier, T-13 critère 9)', () => {
    const onTimeout = vi.fn();
    render(<Toast message="Tâche reportée" onAction={() => undefined} onTimeout={onTimeout} />);
    const button = screen.getByRole('button', { name: 'Annuler' });
    fireEvent.focus(button);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(onTimeout).not.toHaveBeenCalled();
    fireEvent.blur(button, { relatedTarget: document.body });
    act(() => void vi.advanceTimersByTime(5000));
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('survol et focus cumulés : le délai ne reprend qu’à la fin des deux', () => {
    const onTimeout = vi.fn();
    render(<Toast message="Tâche reportée" onAction={() => undefined} onTimeout={onTimeout} />);
    const toast = screen.getByRole('status');
    const button = screen.getByRole('button', { name: 'Annuler' });
    fireEvent.mouseEnter(toast);
    fireEvent.focus(button);
    fireEvent.mouseLeave(toast);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(onTimeout).not.toHaveBeenCalled();
    fireEvent.blur(button, { relatedTarget: null });
    act(() => void vi.advanceTimersByTime(5000));
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
