import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('squelettes et « Réduire les animations » (A-09 critère 7)', () => {
  it('la pulsation est coupée sous prefers-reduced-motion, sans opacité intermédiaire figée', () => {
    const css = readFileSync(join(here, 'Skeleton.css'), 'utf-8');
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/animation:\s*none/);
    expect(block).toMatch(/opacity:\s*0\.7/);
  });

  it('les squelettes de liste réutilisent la classe .ct-skeleton, donc la même règle', () => {
    const tsx = readFileSync(join(here, 'ListSkeleton.tsx'), 'utf-8');
    expect(tsx).toContain('ct-skeleton ');
  });
});
