import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuthenticator, guardAuthenticator, type FakeAuthenticator } from '../../platform/biometric';
import { createFakePrivacyShield } from '../../platform/privacyShield';
import { ChoiceDialog } from '../../ui';
import { resetAppLockStore } from './appLockStore';
import { startAppLock, type AppLockController } from './startAppLock';

/** I-03-7 (revue 2, audit M2, QA D1) : contenu ajouté à body PENDANT le verrou (fenêtre ou bandeau en portail arrivant après la pose). */

let fake: FakeAuthenticator;
let controller: AppLockController | null = null;

async function lockedApp(): Promise<AppLockController> {
  controller = startAppLock({
    authenticator: guardAuthenticator(fake),
    shield: createFakePrivacyShield(),
    readSetting: () => Promise.resolve(true),
    writeSetting: () => Promise.resolve(),
    log: vi.fn(),
  });
  await controller.ready;
  return controller;
}

beforeEach(() => {
  resetAppLockStore();
  fake = createFakeAuthenticator();
  document.body.innerHTML = '<div id="root"><p>contenu</p></div><div id="ct-privacy-cover" aria-hidden="true"></div>';
});

afterEach(() => {
  cleanup();
  controller?.dispose();
  controller = null;
  delete document.documentElement.dataset['appLock'];
});

describe('I-03-7 contenu ajouté au body pendant le verrou', () => {
  it('I-03-7 un enfant de body créé après la pose du verrou est masqué, inerte et caché à VoiceOver', async () => {
    await lockedApp();
    const late = document.createElement('div');
    late.textContent = 'Acheter du lait';
    document.body.appendChild(late);
    // Rappel du MutationObserver : microtâche, aucune attente d'horloge.
    await Promise.resolve();
    expect(late).toHaveAttribute('hidden');
    expect(late).toHaveAttribute('inert');
    expect(late).toHaveAttribute('aria-hidden', 'true');
  });

  it('I-03-7 une ChoiceDialog (portail dans body, comme RestoreChoiceDialog) ouverte sous le verrou n’est pas lisible', async () => {
    await lockedApp();
    render(<ChoiceDialog title={'Restaurer la sauvegarde ?'} options={[{ id: 'keep', label: 'Garder' }]} onChoose={() => undefined} onCancel={() => undefined} />);
    await Promise.resolve();
    expect(screen.queryByRole('dialog', { name: 'Restaurer la sauvegarde ?' })).toBeNull();
    expect(screen.queryByRole('alertdialog', { name: 'Restaurer la sauvegarde ?' })).toBeNull();
    for (const child of Array.from(document.body.children)) {
      if (child.id === 'ct-lock-layer' || child.id === 'ct-privacy-cover') continue;
      expect(child).toHaveAttribute('inert');
    }
  });

  it('I-03-7 déverrouillé : l’observateur est débranché, le contenu ajouté ensuite reste visible', async () => {
    const lock = await lockedApp();
    await lock.unlock();
    const late = document.createElement('div');
    document.body.appendChild(late);
    await Promise.resolve();
    expect(late).not.toHaveAttribute('hidden');
    expect(document.getElementById('root')).not.toHaveAttribute('hidden');
  });

  it('I-03-7 règle CSS : tout enfant de body hors couche du verrou et cache est caché pendant le verrou', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(process.cwd(), 'src', 'features', 'security', 'security.css'), 'utf8');
    expect(css).toMatch(/html\[data-app-lock='locked'\] body > :not\(#ct-lock-layer\):not\(#ct-privacy-cover\) \{\s*display: none !important;/);
  });
});
