import { render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet';

const SAVE = 'Enregistrer';
const CLOSE = 'Fermer';
const TITLE = 'Titre';

describe('Sheet', () => {
  it('ne rend rien quand fermée', () => {
    render(
      <Sheet open={false} onClose={() => undefined} label="Nouvelle tâche">
        <p data-testid="content" />
      </Sheet>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rend un dialogue modal nommé quand ouverte', () => {
    render(
      <Sheet open onClose={() => undefined} label="Nouvelle tâche">
        <p data-testid="content" />
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Nouvelle tâche' })).toHaveAttribute('aria-modal', 'true');
  });

  it('déplace le focus dans la feuille à l’ouverture', () => {
    render(
      <Sheet open onClose={() => undefined} label="Nouvelle tâche">
        <button type="button">{SAVE}</button>
      </Sheet>,
    );
    expect(screen.getByRole('button', { name: SAVE })).toHaveFocus();
  });

  it('appelle onClose sur Échap', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} label="Nouvelle tâche">
        <button type="button">{SAVE}</button>
      </Sheet>,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('Sheet : focus initial (Q-05)', () => {
  it('initialFocusRef reçoit le focus à la place de « Fermer », dans le passage du rendu', () => {
    function Host() {
      const field = useRef<HTMLInputElement>(null);
      return (
        <Sheet open onClose={() => undefined} label="Nouvelle tâche" initialFocusRef={field}>
          <button type="button">{CLOSE}</button>
          <input ref={field} aria-label={TITLE} />
        </Sheet>
      );
    }
    render(<Host />);
    expect(screen.getByLabelText(TITLE)).toHaveFocus();
  });
});
