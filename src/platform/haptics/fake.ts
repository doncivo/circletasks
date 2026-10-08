import type { FeedbackKind, Haptics, ImpactStyle } from './types';

export type FakeHapticsCall = { readonly type: 'impact'; readonly style: ImpactStyle } | { readonly type: 'notification'; readonly kind: FeedbackKind } | { readonly type: 'selection' };

/** Faux du retour haptique : enregistre les appels (tests, e2e en développement via `__ctHapticsFake`). */
export interface FakeHaptics extends Haptics {
  readonly calls: FakeHapticsCall[];
}

export function createFakeHaptics(): FakeHaptics {
  const calls: FakeHapticsCall[] = [];
  return {
    calls,
    impact: (style) => {
      calls.push({ type: 'impact', style });
    },
    notification: (kind) => {
      calls.push({ type: 'notification', kind });
    },
    selection: () => {
      calls.push({ type: 'selection' });
    },
  };
}
