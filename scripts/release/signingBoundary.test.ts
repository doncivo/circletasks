import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/build-windows.yml', import.meta.url), 'utf8');
const starts = [...workflow.matchAll(/^      - /gm)].map(match => match.index);
const steps = starts.map((start, i) => workflow.slice(start, starts[i + 1] ?? workflow.length));
const compile = steps.find(step => step.startsWith("      - name: Compiler l'installeur NSIS"));
const signing = steps.find(step => step.startsWith("      - name: Signer l'installeur NSIS"));

describe('CI-SEC-01 : portée de la clé updater', () => {
  it('le build front et la compilation NSIS ne reçoivent pas la clé', () => {
    expect(compile).toBeDefined();
    expect(compile).not.toMatch(/TAURI_SIGNING_PRIVATE_KEY|createUpdaterArtifacts/);
    expect(compile).toContain('npx tauri build --ci --bundles nsis');
  });

  it('toutes les références aux secrets sont dans la seule étape de signature', () => {
    expect(signing).toBeDefined();
    expect(signing).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY');
    expect(signing).toContain('secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
    expect(workflow.replace(signing ?? '', '')).not.toContain('TAURI_SIGNING_PRIVATE_KEY');
  });

  it('la signature est réservée aux tags et liée à la version, sans compilation', () => {
    expect(signing).toContain("if: github.event_name == 'push' && github.ref_type == 'tag'");
    expect(signing).toContain('node scripts/release/check-version.mjs');
    expect(signing).toContain('signer sign --app-version');
    expect(signing).not.toMatch(/\b(?:tauri build|npm run build|vite build|cargo build)\b/);
    expect(signing).not.toMatch(/\bset\s+-x|\b(?:echo|printf)[^\n]*\$(?:\{)?TAURI_SIGNING_PRIVATE_KEY/);
  });

  it('la collecte vérifie la signature avant le job de publication', () => {
    const collect = steps.find(step => step.startsWith('      - name: Rassembler installeur, signature et latest.json'));
    expect(collect).toContain('verify-signature.mjs');
    expect(collect).toContain('sha256sum');
    expect(workflow.indexOf(collect ?? '')).toBeLessThan(workflow.indexOf('  publish:'));
    expect(workflow).toContain("if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
  });
});
