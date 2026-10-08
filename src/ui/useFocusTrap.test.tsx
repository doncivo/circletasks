import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

const OUTSIDE = 'Dehors';
const FIRST = 'Premier';
const LAST = 'Dernier';
const DEACTIVATE = 'Désactiver';
const TARGET = 'Champ visé';
const OTHER = 'Champ automatique';
const ACTIVE = 'Déjà actif';

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

function Rerendering() {
  const [count, setCount] = useState(0);
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: () => undefined }); // nouveau rappel à chaque rendu
  return (
    <div ref={ref} tabIndex={-1}>
      <button type="button">{FIRST}</button>
      <button type="button" onClick={() => setCount(count + 1)}>
        {LAST}
      </button>
    </div>
  );
}

describe('useFocusTrap : rappel instable', () => {
  it('le focus ne saute pas au premier élément quand le parent se re-rend', () => {
    render(<Rerendering />);
    const last = screen.getByRole('button', { name: LAST });
    last.focus();
    fireEvent.click(last);
    expect(last).toHaveFocus();
  });
});

function WithInitial({ autoFocusSecond = false }: { autoFocusSecond?: boolean }) {
  const target = useRef<HTMLInputElement>(null);
  const ref = useFocusTrap<HTMLDivElement>({ active: true, initialFocus: target });
  return (
    <div ref={ref} tabIndex={-1}>
      <button type="button">{FIRST}</button>
      <input ref={target} aria-label={TARGET} />
      <input aria-label={OTHER} autoFocus={autoFocusSecond} />
    </div>
  );
}

describe('useFocusTrap : focus initial (Q-05)', () => {
  it('place le focus sur l’élément demandé, avant tout temporisateur (effet de mise en page)', () => {
    render(<WithInitial />);
    expect(screen.getByLabelText(TARGET)).toHaveFocus();
  });

  it('sans élément demandé : premier élément focusable (comportement inchangé)', () => {
    render(<Harness onEscape={() => undefined} />);
    expect(screen.getByRole('button', { name: FIRST })).toHaveFocus();
  });

  it('ne vole pas le focus : un élément du conteneur déjà actif est conservé quand rien n’est demandé', () => {
    function Keep() {
      const ref = useFocusTrap<HTMLDivElement>({ active: true });
      return (
        <div ref={ref} tabIndex={-1}>
          <button type="button">{FIRST}</button>
          <input aria-label={ACTIVE} autoFocus />
        </div>
      );
    }
    render(<Keep />);
    expect(screen.getByLabelText(ACTIVE)).toHaveFocus();
  });
});
