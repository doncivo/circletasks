import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: () => Promise.reject(new Error('jamais appelé')) } }));

const { awaitStartupGate, StartupGateTimeoutError, StartupRecoveryError } = await import('./sqlDriver');

/** P-04-iOS critère 5 (ADR 0009 avenant lot F B3) : avant `Database.load`, l'iPhone attend l'issue de la récupération faite par Rust. */
describe('P-04-iOS : porte de démarrage avant l’ouverture de la base', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('prête : la base peut s’ouvrir ; en attente : nouvel essai jusqu’à la fin du setup', async () => {
    const answers = [{ state: 'pending' as const }, { state: 'pending' as const }, { state: 'ready' as const }];
    const status = vi.fn(() => Promise.resolve(answers.shift() ?? { state: 'ready' as const }));
    await expect(awaitStartupGate({ status, sleep: noSleep })).resolves.toBeUndefined();
    expect(status).toHaveBeenCalledTimes(3);
  });

  it('échec de la récupération : StartupRecoveryError avec le code (écran persistant, aucune base ouverte ni créée)', async () => {
    const error: unknown = await awaitStartupGate({ status: () => Promise.resolve({ state: 'failed', code: 'recovery-conflict' }), sleep: noSleep }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupRecoveryError);
    expect(error).toMatchObject({ name: 'StartupRecoveryError', code: 'recovery-conflict', message: 'startup-recovery: recovery-conflict' });
  });

  it('statut illisible ou setup trop long : StartupGateTimeoutError (passager, « Réessayer » peut réussir), jamais une attente sans fin', async () => {
    await expect(awaitStartupGate({ status: () => Promise.reject(new Error('ipc')), sleep: noSleep })).rejects.toMatchObject({ name: 'StartupGateTimeoutError', code: 'status-unavailable' });
    const status = vi.fn(() => Promise.resolve({ state: 'pending' as const }));
    const error: unknown = await awaitStartupGate({ status, sleep: noSleep, intervalMs: 50, timeoutMs: 500 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StartupGateTimeoutError);
    expect(status).toHaveBeenCalledTimes(11);
  });
});
