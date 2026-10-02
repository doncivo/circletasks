import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu } from './ActionMenu';

const items = [
  { id: 'a', label: 'Demain' },
  { id: 'b', label: 'Semaine prochaine' },
];

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('ActionMenu', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ne rend rien fermé', () => {
    mockViewport(1440);
    render(<ActionMenu open={false} label="Menu" items={items} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('PC : menu déroulant, sélection, Échap et clic extérieur ferment', () => {
    mockViewport(1440);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ActionMenu open label="Menu" items={items} onSelect={onSelect} onClose={onClose} />);
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Semaine prochaine' }));
    expect(onSelect).toHaveBeenCalledWith('b');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('PC : les flèches déplacent le focus entre les actions', () => {
    mockViewport(1440);
    render(<ActionMenu open label="Menu" items={items} onSelect={vi.fn()} onClose={vi.fn()} />);
    const [first, second] = screen.getAllByRole('menuitem');
    first?.focus();
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
  });

  it('PC : Tab ferme le menu au lieu de boucler', () => {
    mockViewport(1440);
    const onClose = vi.fn();
    render(<ActionMenu open label="Menu" items={items} onSelect={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getAllByRole('menuitem')[1] as HTMLElement, { key: 'Tab' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('iPhone : feuille d’actions avec bouton Fermer', () => {
    mockViewport(440);
    const onClose = vi.fn();
    render(<ActionMenu open label="Menu" items={items} onSelect={vi.fn()} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(onClose).toHaveBeenCalled();
  });
});
