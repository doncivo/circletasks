import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockViewport, renderChecklists, setupChecklists, teardownChecklists, type ChecklistsHarness } from './testKit';

describe('C-FIX-01 : focus dans le geste d’ouverture', () => {
  let h: ChecklistsHarness | undefined;
  afterEach(async () => { if (h) await teardownChecklists(h); h = undefined; });

  it.each([440, 393, 1440])('titre immédiatement actif à %s px, puis restitution du focus', async width => {
    h = await setupChecklists('908');
    mockViewport(width);
    renderChecklists(h.container);
    await screen.findByText('Aucune checklist pour l’instant');
    const open = screen.getByRole('button', { name: width < 1024 ? 'Nouvelle checklist' : '+ Nouvelle checklist' });
    open.focus();
    fireEvent.click(open);
    // Assertion synchrone : attendre une promesse ou une minuterie masquerait le défaut WKWebView.
    const sheet = screen.getByRole(width < 1024 ? 'dialog' : 'complementary', { name: 'Nouvelle checklist' });
    const title = within(sheet).getByLabelText('Titre de la checklist');
    expect(title).toHaveFocus();
    fireEvent.change(title, { target: { value: 'Valise' } });
    expect(title).toHaveFocus();
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(screen.queryByRole(width < 1024 ? 'dialog' : 'complementary', { name: 'Nouvelle checklist' })).toBeNull();
    expect(open).toHaveFocus();
  });
});
