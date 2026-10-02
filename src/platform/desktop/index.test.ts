import { describe, expect, it, vi } from 'vitest';

vi.mock('./tauriDesktop', () => ({ createTauriDesktop: () => ({ marker: 'tauri' }) }));

const { openDesktopPlatform } = await import('./index');

describe('openDesktopPlatform', () => {
  it('renvoie null dans le navigateur (npm run dev, Playwright) et sur iPhone', async () => {
    await expect(openDesktopPlatform('web', 'other')).resolves.toBeNull();
    await expect(openDesktopPlatform('web', 'windows')).resolves.toBeNull();
    await expect(openDesktopPlatform('tauri', 'ios')).resolves.toBeNull();
  });

  it('renvoie l’intégration Tauri sur Windows installé', async () => {
    await expect(openDesktopPlatform('tauri', 'windows')).resolves.toMatchObject({ marker: 'tauri' });
  });
});
