import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeOcr } from '../../../platform/ocr/testing';
import type { OcrService } from '../../../platform/ocr';

const mocks = vi.hoisted(() => ({ service: null as OcrService | null }));
vi.mock('../../../platform/ocr', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openOcrService: () => mocks.service,
}));

// Importé après le mock : le bouton lit les moteurs par `openOcrService`.
const { ScanButton } = await import('./ScanButton');

const svc = (native: boolean, embedded: boolean): OcrService => ({
  primary: createFakeOcr({ id: 'windows', available: native }),
  fallback: createFakeOcr({ id: 'tesseract', available: embedded }),
  dispose: () => Promise.resolve(),
});

describe('« Scan tâches » : disponibilité du moteur (Q-04 critère 1)', () => {
  afterEach(() => {
    cleanup();
    mocks.service = null;
  });

  it('Q-04 critère 1 : visible quand le moteur du système est disponible', async () => {
    mocks.service = svc(true, false);
    render(<ScanButton layout="pc" />);
    expect(await screen.findByRole('button', { name: 'Scan tâches' })).toBeInTheDocument();
  });

  it('Q-04 critère 1 : visible avec le seul repli intégré', async () => {
    mocks.service = svc(false, true);
    render(<ScanButton layout="phone" />);
    expect(await screen.findByRole('button', { name: 'Scan tâches' })).toBeInTheDocument();
  });

  it('Q-04 critère 1 : masqué si aucun moteur de lecture n’est disponible', async () => {
    const service = svc(false, false);
    mocks.service = service;
    render(<ScanButton layout="pc" />);
    const native = service.primary as ReturnType<typeof createFakeOcr>;
    await waitFor(() => expect(native.statusCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('button', { name: 'Scan tâches' })).not.toBeInTheDocument();
  });
});
