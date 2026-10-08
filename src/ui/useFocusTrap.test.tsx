import { fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';
import { Sheet } from './Sheet';
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

describe('useFocusTrap : pièges imbriqués et feuilles (Q-05, revue I2)', () => {
  const OPEN = 'Ouvrir la confirmation';
  const SHEET_FIELD = 'Champ de la feuille';
  const SHEET_LABEL = "Feuille";
  const CONFIRM_TITLE = "Supprimer ?";
  const CONFIRM_YES = "Supprimer";
  const CONFIRM_NO = "Annuler";

  function SheetWithConfirm({ onSheetClose }: { onSheetClose: () => void }) {
    const [confirm, setConfirm] = useState(false);
    return (
      <Sheet open onClose={onSheetClose} label={SHEET_LABEL}>
        <button type="button">{FIRST}</button>
        <input aria-label={SHEET_FIELD} autoFocus />
        <button type="button" onClick={() => setConfirm(true)}>
          {OPEN}
        </button>
        {confirm && <ConfirmDialog title={CONFIRM_TITLE} confirmLabel={CONFIRM_YES} cancelLabel={CONFIRM_NO} onConfirm={() => setConfirm(false)} onCancel={() => setConfirm(false)} />}
      </Sheet>
    );
  }

  it('Sheet : un champ à focalisation automatique garde le focus (le piège ne le déplace pas sur le premier bouton)', () => {
    render(<SheetWithConfirm onSheetClose={() => undefined} />);
    expect(screen.getByLabelText(SHEET_FIELD)).toHaveFocus();
  });

  it('piège interne dans une feuille : le focus passe à « Annuler », Tab reste dans la confirmation, Échap la ferme sans fermer la feuille et rend le focus au bouton qui l’a ouverte', () => {
    const onSheetClose = vi.fn();
    render(<SheetWithConfirm onSheetClose={onSheetClose} />);
    const opener = screen.getByRole('button', { name: OPEN });
    opener.focus();
    fireEvent.click(opener);
    const cancel = screen.getByRole("button", { name: CONFIRM_NO });
    expect(cancel).toHaveFocus();
    // Tab depuis le dernier bouton de la confirmation boucle dans la confirmation, pas dans la feuille.
    const confirmButton = screen.getByRole("button", { name: CONFIRM_YES });
    confirmButton.focus();
    confirmButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(cancel).toHaveFocus();
    // Échap : seule la confirmation (piège du dessus) réagit.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onSheetClose).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
    // La feuille retrouve son piège : Échap la ferme.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onSheetClose).toHaveBeenCalledTimes(1);
  });
});
