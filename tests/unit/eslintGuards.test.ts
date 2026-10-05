import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fous ESLint (ADR 0001, avenants PERF-02) : la config plate prend le DERNIER bloc qui définit une règle ; ce test prouve qu'un
 * bloc ajouté ne désactive pas les interdictions des autres (couches, API Tauri, blocs à la demande, imports nus).
 */
const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
}

describe('config ESLint : interdictions qui se cumulent', () => {
  it.each([
    ['src/App.tsx', "import { invoke } from '@tauri-apps/api/core';\nexport const x = invoke;\n"],
    ['src/main.tsx', "import { invoke } from '@tauri-apps/api/core';\nexport const x = invoke;\n"],
    ['src/App.tsx', "import { x } from './db/drivers/sqlite';\nexport const y = x;\n"],
    ['src/features/today/zz.ts', "import { invoke } from '@tauri-apps/api/core';\nexport const x = invoke;\n"],
    ['src/captureMain.tsx', "import { en } from './i18n/en';\nexport const x = en;\n"],
    ['src/App.tsx', "import { en } from './i18n/en';\nexport const x = en;\n"],
    ['src/i18n/zz.ts', "import { en } from './en';\nexport const x = en;\n"],
    ['src/domain/zz.ts', "import { chronoAbsoluteParser } from './chronoAbsolute';\nexport const x = chronoAbsoluteParser;\n"],
    ['src/features/capture/zz.ts', "import { chronoAbsoluteParser } from '../../domain/chronoAbsolute';\nexport const x = chronoAbsoluteParser;\n"],
    ['src/platform/zz.ts', "import { en } from '../i18n/en';\nexport const x = en;\n"],
  ])('%s : import interdit signalé', async (filePath, code) => {
    expect(await ruleIds(filePath, code)).toContain('no-restricted-imports');
  });

  it('un import nu hors CSS est interdit dans src, un import CSS nu est permis', async () => {
    expect(await ruleIds('src/features/today/zz.ts', "import './effet';\n")).toContain('no-restricted-syntax');
    expect(await ruleIds('src/features/today/zz.ts', "import './zz.css';\n")).not.toContain('no-restricted-syntax');
  });

  it('import() dynamique du bloc à la demande : permis (c’est le chargement prévu)', async () => {
    expect(await ruleIds('src/i18n/zz.ts', "export const load = () => import('./en');\n")).toEqual([]);
    expect(await ruleIds('src/features/capture/zz.ts', "export const load = () => import('../../domain/chronoAbsolute');\n")).toEqual([]);
  });
});
