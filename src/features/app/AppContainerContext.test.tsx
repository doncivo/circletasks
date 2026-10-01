import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import type { DeviceId } from '../../domain/types';
import { AppContainerProvider, useAppContainer, useFeatureStore } from './AppContainerContext';
import { createAppContainer, defineFeatureStore } from './container';

const clock = createManualClock('2026-10-01T08:00:00.000Z');
const container = createAppContainer({
  clock,
  hlc: createHlcClock({ clock, deviceId: '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId }),
  data: {} as never,
});
const demo = defineFeatureStore(() => createStore(() => ({ count: 3 })));

function Probe() {
  const count = useFeatureStore(demo, (s) => s.count);
  const c = useAppContainer();
  return <output data-device={c.hlc.deviceId}>{count}</output>;
}

describe('AppContainerProvider', () => {
  it('fournit le conteneur et ses stores de feature', () => {
    render(
      <AppContainerProvider container={container}>
        <Probe />
      </AppContainerProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('3');
  });

  it('refuse un usage hors fournisseur', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined); // trace React attendue
    const silence = (event: ErrorEvent) => event.preventDefault(); // erreur jsdom attendue
    window.addEventListener('error', silence);
    expect(() => render(<Probe />)).toThrow(/AppContainerProvider/);
    window.removeEventListener('error', silence);
    spy.mockRestore();
  });
});
