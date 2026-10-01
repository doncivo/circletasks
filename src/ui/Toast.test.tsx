import { render, screen } from '@testing-library/react';
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
});
