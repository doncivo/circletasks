import { render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { settle } from '../../../tests/setup/settle';
import type { SqlDriver } from '../../db/driver';

const driver = { select: () => Promise.resolve([]) } as unknown as SqlDriver;

/** Un écran qui se redessine à chaque tour (jusqu'à `limit` fois). */
function Ticker({ limit }: { readonly limit: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= limit) return undefined;
    const timer = setTimeout(() => setN(n + 1), 0);
    return () => clearTimeout(timer);
  }, [n, limit]);
  return <p>{n}</p>;
}

describe('settle (aide de test)', () => {
  it('rend la main quand l’écran ne change plus', async () => {
    const view = render(<Ticker limit={3} />);
    await settle(driver);
    expect(view.getByText('3')).toBeInTheDocument();
  });

  it('écran qui change à chaque tour : erreur explicite après le nombre de tours', async () => {
    render(<Ticker limit={Number.MAX_SAFE_INTEGER} />);
    await expect(settle(driver, 5)).rejects.toThrow('écran jamais stable après 5 tours');
  });
});
