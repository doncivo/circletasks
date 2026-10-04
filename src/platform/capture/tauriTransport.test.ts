import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn((command: string, args?: unknown) => Promise.resolve({ command, args }));
const emitTo = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string, args?: unknown) => invoke(command, args) }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: (...args: unknown[]) => emitTo(...args), listen: vi.fn() }));

const { createTauriTransport } = await import('./transports');

/** Sécurité (Q-01) : la mini-fenêtre ne peut émettre aucun événement libre (elle imiterait desktop://quitting). */
describe('transport Tauri de la capture', () => {
  beforeEach(() => {
    invoke.mockClear();
    emitTo.mockClear();
  });

  it('mini-fenêtre : le texte part par la commande dédiée, jamais par emitTo', async () => {
    const transport = createTauriTransport('window');
    await transport.emit('main', 'capture:submit', { requestId: 'r', text: 'x', ignored: [] });
    await transport.emit('main', 'capture:context-request', null);
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(['submit_quick_capture', 'request_capture_context']);
    expect(invoke.mock.calls[0]?.[1]).toEqual({ request: { requestId: 'r', text: 'x', ignored: [] } });
    expect(emitTo).not.toHaveBeenCalled();
  });

  it('mini-fenêtre : tout autre événement est refusé', async () => {
    const transport = createTauriTransport('window');
    await expect(transport.emit('main', 'desktop://quitting', null)).rejects.toThrow('non autorisé');
    expect(invoke).not.toHaveBeenCalled();
    expect(emitTo).not.toHaveBeenCalled();
  });

  it('fenêtre principale : événements ciblés vers la mini-fenêtre', async () => {
    await createTauriTransport('main').emit('quick-capture', 'capture:done', { ok: true });
    expect(emitTo).toHaveBeenCalledTimes(1);
  });
});
