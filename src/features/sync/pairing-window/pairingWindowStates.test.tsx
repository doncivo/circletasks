// @vitest-environment jsdom
// Y-IOS-02, QA du parcours d'association (demande d'Ali, 0.2.2) : fenêtre QR du PC, état par état. Chaque état offre une sortie
// (« Annuler » ou « Fermer ») et le texte juste ; le code affiché reste utilisable tant qu'il est valable, même si « Nouveau code » échoue.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import qrcode from 'qrcode-generator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncPairingWindowFr } from '../../../i18n/fr.syncPairing';
import { SyncPlatformError } from '../../../platform/sync';
import type { PairingPayload } from '../../../platform/sync/types';
import type { PairingPlatform } from './pairingPlatform';
import { PairingRoot, PairingView } from './PairingView';

const T = syncPairingWindowFr;
const T0 = 1_800_000_000_000;

let nowMs = T0;
const now = (): number => nowMs;
const payload = (n: number): PairingPayload => ({ qrText: `CTPAIR1.fake${String(n)}`, recoveryKey: 'CT1-AAAAA-BBBBB-CCCCC', expiresAt: T0 + 5 * 60_000 });

interface Fake extends PairingPlatform {
  readonly closes: () => number;
}

function fakePlatform(overrides: Partial<PairingPlatform> = {}): Fake {
  let closes = 0;
  return {
    pairingPayload: () => Promise.resolve(payload(1)),
    closePairing: () => {
      closes += 1;
      return Promise.resolve();
    },
    import: () => Promise.reject(new SyncPlatformError('invalid-pairing')),
    ...overrides,
    closes: () => closes,
  };
}

const loadQr = () => Promise.resolve(qrcode);

beforeEach(() => {
  nowMs = T0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount(platform: PairingPlatform): Promise<void> {
  render(<PairingView platform={platform} now={now} loadQr={loadQr} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const names = (): string[] => screen.queryAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '').sort();

describe('Y-IOS-02 fenêtre QR du PC : chaque état offre une sortie', () => {
  it('Q01 code affiché : imprimer, nouveau code, annuler ; le QR et la clé de secours sont là', async () => {
    await mount(fakePlatform());
    expect(screen.getByRole('img', { name: T.window.qrLabel })).toBeInTheDocument();
    expect(screen.getByTestId('pairing-recovery-key')).toHaveTextContent('CT1-AAAAA-BBBBB-CCCCC');
    expect(names()).toEqual([T.window.cancelLabel, T.window.print, T.window.renewLabel].sort());
  });

  it('Q02 « Nouveau code » refusé (confirmation refusée) : message, le code affiché reste, les trois actions restent', async () => {
    const platform = fakePlatform({ pairingPayload: (o) => (o?.renew ? Promise.reject(new SyncPlatformError('consent-denied')) : Promise.resolve(payload(1))) });
    await mount(platform);
    fireEvent.click(screen.getByRole('button', { name: T.window.renewLabel }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(T.window.renewDenied)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: T.window.qrLabel })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: T.window.renewLabel })).toBeEnabled();
  });

  it('Q03 « Nouveau code » trop demandé (3 par 10 minutes) : message, le code affiché reste valable', async () => {
    const platform = fakePlatform({ pairingPayload: (o) => (o?.renew ? Promise.reject(new SyncPlatformError('rate-limited')) : Promise.resolve(payload(1))) });
    await mount(platform);
    fireEvent.click(screen.getByRole('button', { name: T.window.renewLabel }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(T.window.renewRateLimited)).toBeInTheDocument();
    expect(screen.getByTestId('pairing-validity')).toHaveTextContent('Code valable 5 minutes');
  });

  it('Q04 code expiré : « Code expiré » et « Fermer » (la fenêtre est détruite par Rust, l’écran ne reste pas sans sortie)', async () => {
    await mount(fakePlatform());
    nowMs = T0 + 5 * 60_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText(T.window.expired)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: T.window.qrLabel })).toBeNull();
    expect(screen.queryByTestId('pairing-recovery-key')).toBeNull();
    expect(names()).toEqual([T.window.close]);
  });

  it('Q05 code impossible à produire (jeton refusé, base illisible…) : texte qui dit de recommencer depuis Réglages, « Fermer »', async () => {
    await mount(fakePlatform({ pairingPayload: () => Promise.reject(new SyncPlatformError('io')) }));
    expect(screen.getByText(T.window.loadFailed)).toBeInTheDocument();
    expect(names()).toEqual([T.window.close]);
  });

  it('Q06 fenêtre qui refuse de se fermer : le dit et « Fermer » relance la demande, jusqu’à ce qu’elle aboutisse', async () => {
    let attempts = 0;
    const platform = fakePlatform({
      closePairing: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new SyncPlatformError('io')) : Promise.resolve();
      },
    });
    await mount(platform);
    fireEvent.click(screen.getByRole('button', { name: T.window.cancelLabel }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(T.window.closeFailed)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: T.window.close }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(attempts).toBe(2);
    expect(screen.queryByText(T.window.closeFailed)).toBeNull();
  });

  it('Q07 « Annuler » : le QR et la clé de secours disparaissent de l’écran, « Fermer » reste', async () => {
    const platform = fakePlatform();
    await mount(platform);
    fireEvent.click(screen.getByRole('button', { name: T.window.cancelLabel }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(platform.closes()).toBe(1);
    expect(screen.queryByTestId('pairing-recovery-key')).toBeNull();
    expect(screen.queryByRole('img', { name: T.window.qrLabel })).toBeNull();
    expect(names()).toEqual([T.window.close]);
  });

  it('Q08 plateforme impossible à démarrer : le dit dans la fenêtre, jamais une page blanche', async () => {
    render(<PairingRoot open={() => Promise.reject(new Error('démarrage'))} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(T.window.startFailed)).toBeInTheDocument();
  });

  it('Q09 instance « clé de secours » : clé erronée, message et nouvelle saisie ; « Annuler » ferme', async () => {
    const platform = fakePlatform({ pairingPayload: () => Promise.reject(new SyncPlatformError('wrong-mode')), import: () => Promise.reject(new SyncPlatformError('key-mismatch')) });
    const { PairingWindow } = await import('./PairingView');
    render(<PairingWindow platform={platform} now={now} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const field = screen.getByLabelText(T.import.field);
    fireEvent.change(field, { target: { value: 'CT1-AAAAA' } });
    fireEvent.click(screen.getByRole('button', { name: T.import.submit }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('pairing-import-message')).toHaveTextContent(T.errors.keyMismatch);
    expect(screen.getByRole('button', { name: T.import.submit })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: T.window.cancelLabel }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(platform.closes()).toBe(1);
  });
});
