/* eslint-disable react-hooks/refs -- faux positif : le hook rend des propriétés de saisie (données), aucune ref n’est lue au rendu. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useZoneDrag } from './useZoneDrag';

/**
 * S-02 : primitive de glisser-déposer entre zones. jsdom n'a ni mise en page ni `elementsFromPoint` : les rectangles et la
 * pile d'éléments sous le pointeur sont simulés (zones empilées verticalement, 100 px de haut chacune).
 */

const ZONES = ['2026-09-23', '2026-09-24'] as const;
/** Textes de la maquette de test : variables, pas de texte d'interface en dur dans le JSX. */
const LABEL = { a: 'Item A', b: 'Item B', routine: 'Routine', c: 'Item C', field: 'champ' } as const;

interface HarnessProps {
  readonly onDrop: (id: string, zone: string, index: number) => void;
  readonly isMovable?: (id: string) => boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly onState?: (state: unknown) => void;
}

function Harness({ onDrop, isMovable = () => true, disabled, onClick, onState }: HarnessProps) {
  const zoneDrag = useZoneDrag({ onDrop, isMovable, ...(disabled ? { disabled } : {}) });
  onState?.(zoneDrag.drag);
  return (
    <div>
      {ZONES.map((zone) => (
        <section key={zone} data-drop-zone={zone} data-testid={`zone-${zone}`}>
          {zone === ZONES[0] ? (
            <>
              <div {...zoneDrag.itemProps('a')} data-testid="a">
                <button type="button" onClick={onClick}>{LABEL.a}</button>
                <input aria-label={LABEL.field} />
              </div>
              <div {...zoneDrag.itemProps('b')} data-testid="b">{LABEL.b}</div>
              <div data-testid="routine">{LABEL.routine}</div>
            </>
          ) : (
            <div {...zoneDrag.itemProps('c')} data-testid="c">{LABEL.c}</div>
          )}
        </section>
      ))}
      {zoneDrag.drag && <div ref={zoneDrag.attachGhost} data-drag-ghost data-testid="ghost" />}
    </div>
  );
}

/** Pile d'éléments sous (x, y) : zone du jeudi à partir de y = 100, mercredi avant ; hors écran au-delà de 200. */
function stubHitTesting(): void {
  document.elementsFromPoint = (x: number, y: number) => {
    void x;
    if (y < 0 || y > 200) return [document.body];
    const zone = y < 100 ? ZONES[0] : ZONES[1];
    return [screen.getByTestId(`zone-${zone}`)];
  };
  // Cartes de la zone du mercredi : A (0-40), B (40-80) ; centre en 20 et 60.
  const tops: Record<string, number> = { a: 0, b: 40, c: 100 };
  for (const id of Object.keys(tops)) {
    const element = screen.getByTestId(id);
    element.getBoundingClientRect = () => ({ top: tops[id] ?? 0, height: 40, bottom: (tops[id] ?? 0) + 40, left: 0, right: 100, width: 100, x: 0, y: tops[id] ?? 0, toJSON: () => ({}) });
  }
}

function pointer(target: EventTarget, type: string, init: { x?: number; y?: number; pointerType?: 'mouse' | 'touch'; button?: number } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x ?? 10, clientY: init.y ?? 20, button: init.button ?? 0 });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('useZoneDrag (S-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 16));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  });
  afterEach(() => {
    // Les écouteurs « clic ignoré » ne se retirent qu'à l'échéance de leur minuterie.
    vi.runOnlyPendingTimers();
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const frame = (): void => {
    act(() => {
      vi.advanceTimersByTime(20);
    });
  };

  it('souris : le glisser démarre après quelques pixels, le lâcher dans une autre zone donne zone et position', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown');
    pointer(window, 'pointermove', { x: 40, y: 150 });
    frame();
    expect(screen.getByTestId('ghost')).toBeInTheDocument();
    expect(screen.getByTestId('a')).toHaveAttribute('data-dragging', 'true');
    pointer(window, 'pointerup', { x: 40, y: 150 });
    expect(onDrop).toHaveBeenCalledWith('a', '2026-09-24', 1); // une autre carte (C, centre 120) est au-dessus de y = 150
    expect(screen.queryByTestId('ghost')).not.toBeInTheDocument();
  });

  it('dans la même zone, la position est le nombre d’AUTRES éléments au-dessus du pointeur', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown', { y: 20 });
    pointer(window, 'pointermove', { x: 30, y: 90 });
    pointer(window, 'pointerup', { x: 30, y: 90 });
    expect(onDrop).toHaveBeenCalledWith('a', '2026-09-23', 1); // B (centre 60) est au-dessus de y = 90
  });

  it('un clic sans déplacement n’est pas un glisser', () => {
    const onDrop = vi.fn();
    const onClick = vi.fn();
    render(<Harness onDrop={onDrop} onClick={onClick} />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown');
    pointer(window, 'pointermove', { x: 11, y: 21 });
    pointer(window, 'pointerup', { x: 11, y: 21 });
    fireEvent.click(screen.getByRole('button', { name: LABEL.a }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('le clic qui suit un glisser est ignoré (la fiche ne s’ouvre pas)', () => {
    const onClick = vi.fn();
    render(<Harness onDrop={vi.fn()} onClick={onClick} />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown');
    pointer(window, 'pointermove', { x: 40, y: 150 });
    pointer(window, 'pointerup', { x: 40, y: 150 });
    fireEvent.click(screen.getByRole('button', { name: LABEL.a }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Échap abandonne le glisser sans rien déplacer (critère 5)', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown');
    pointer(window, 'pointermove', { x: 40, y: 150 });
    frame();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('ghost')).not.toBeInTheDocument();
    pointer(window, 'pointerup', { x: 40, y: 150 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('un lâcher hors de toute zone ne fait rien (critère 5)', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown');
    pointer(window, 'pointermove', { x: 40, y: 400 });
    pointer(window, 'pointerup', { x: 40, y: 400 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('l’annulation du pointeur abandonne le glisser', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown');
    pointer(window, 'pointermove', { x: 40, y: 150 });
    pointer(window, 'pointercancel');
    pointer(window, 'pointerup', { x: 40, y: 150 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('un élément non déplaçable, un champ de saisie ou un bouton droit ne déclenchent rien (critère 6)', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} isMovable={(id) => id !== 'a'} />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown');
    pointer(window, 'pointermove', { x: 40, y: 150 });
    pointer(window, 'pointerup', { x: 40, y: 150 });
    expect(onDrop).not.toHaveBeenCalled();

    pointer(screen.getByTestId('b'), 'pointerdown', { button: 2 });
    pointer(window, 'pointermove', { x: 40, y: 150 });
    pointer(window, 'pointerup', { x: 40, y: 150 });
    pointer(screen.getByLabelText(LABEL.field), 'pointerdown');
    pointer(window, 'pointermove', { x: 40, y: 150 });
    pointer(window, 'pointerup', { x: 40, y: 150 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('désactivé : aucun glisser', () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} disabled />);
    stubHitTesting();
    pointer(screen.getByTestId('a'), 'pointerdown');
    pointer(window, 'pointermove', { x: 40, y: 150 });
    pointer(window, 'pointerup', { x: 40, y: 150 });
    expect(onDrop).not.toHaveBeenCalled();
  });

  describe('toucher (appui long)', () => {
    it('saisit l’élément après l’appui long, puis le lâcher le dépose (critère 4)', () => {
      const onDrop = vi.fn();
      render(<Harness onDrop={onDrop} />);
      stubHitTesting();
      pointer(screen.getByTestId('a'), 'pointerdown', { pointerType: 'touch' });
      expect(screen.queryByTestId('ghost')).not.toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.getByTestId('ghost')).toBeInTheDocument();
      pointer(window, 'pointermove', { x: 20, y: 150, pointerType: 'touch' });
      pointer(window, 'pointerup', { x: 20, y: 150, pointerType: 'touch' });
      expect(onDrop).toHaveBeenCalledWith('a', '2026-09-24', 1);
    });

    it('un toucher bref reste un clic : rien n’est saisi', () => {
      const onDrop = vi.fn();
      render(<Harness onDrop={onDrop} />);
      stubHitTesting();
      pointer(screen.getByTestId('a'), 'pointerdown', { pointerType: 'touch' });
      act(() => {
        vi.advanceTimersByTime(150);
      });
      pointer(window, 'pointerup', { pointerType: 'touch' });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId('ghost')).not.toBeInTheDocument();
      expect(onDrop).not.toHaveBeenCalled();
    });

    it('un défilement avant la fin de l’appui n’est jamais gêné : la saisie est abandonnée', () => {
      const onDrop = vi.fn();
      render(<Harness onDrop={onDrop} />);
      stubHitTesting();
      pointer(screen.getByTestId('a'), 'pointerdown', { pointerType: 'touch' });
      pointer(window, 'pointermove', { x: 10, y: 60, pointerType: 'touch' }); // 40 px : c'est un défilement
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId('ghost')).not.toBeInTheDocument();
      pointer(window, 'pointerup', { y: 60, pointerType: 'touch' });
      expect(onDrop).not.toHaveBeenCalled();
    });

    it('une fois saisi, le défilement de la page est suspendu (touchmove annulé)', () => {
      render(<Harness onDrop={vi.fn()} />);
      stubHitTesting();
      pointer(screen.getByTestId('a'), 'pointerdown', { pointerType: 'touch' });
      const before = new Event('touchmove', { cancelable: true, bubbles: true });
      window.dispatchEvent(before);
      expect(before.defaultPrevented).toBe(false);
      act(() => {
        vi.advanceTimersByTime(450);
      });
      const after = new Event('touchmove', { cancelable: true, bubbles: true });
      window.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(true);
    });
  });
});
