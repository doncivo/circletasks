import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

const OUTSIDE = 'Dehors';
const FIRST = 'Premier';
const LAST = 'Dernier';
const DEACTIVATE = 'Désactiver';

function Harness({ onEscape }: { onEscape: () => void }) {
  const [active, setActive] = useState(true);
  const ref = useFocusTrap<HTMLDivElement>({ active, onEscape });
  return (
    <div>
      <button type="button">{OUTSIDE}</button>
      {active && (
        <div ref={ref} tabIndex={-1} data-testid="trap">
          <button type="button">{FIRST}</button>
          <button type="button">{LAST}</button>
        </div>
      )}
      <button type="button" onClick={() => setActive(false)}>
        {DEACTIVATE}
      </button>
    </div>
  );
}

describe('useFocusTrap', () => {
  it('déplace le focus sur le premier élément à l’activation', () => {
    render(<Harness onEscape={() => undefined} />);
    expect(screen.getByRole('button', { name: FIRST })).toHaveFocus();
  });

  it('boucle de Dernier vers Premier avec Tab', () => {
    render(<Harness onEscape={() => undefined} />);
    const last = screen.getByRole('button', { name: LAST });
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(screen.getByRole('button', { name: FIRST })).toHaveFocus();
  });

  it('boucle de Premier vers Dernier avec Maj+Tab', () => {
    render(<Harness onEscape={() => undefined} />);
    const first = screen.getByRole('button', { name: FIRST });
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(screen.getByRole('button', { name: LAST })).toHaveFocus();
  });

  it('appelle onEscape sur Échap', () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('restaure le focus précédent à la désactivation', () => {
    render(<Harness onEscape={() => undefined} />);
    const deactivate = screen.getByRole('button', { name: DEACTIVATE });
    deactivate.focus();
    fireEvent.click(deactivate);
    expect(screen.queryByTestId('trap')).not.toBeInTheDocument();
  });
});
