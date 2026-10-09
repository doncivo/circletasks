// Mesures e2e @perf sur le build de production : pose CT_E2E_PERF=1 (playwright.config.ts ne définit le projet `perf` et son second serveur,
// `vite build` + `vite preview`, que dans ce cas) puis lance Playwright sur le projet perf. Arguments supplémentaires transmis tels quels.
// Local : `npm run test:perf:e2e -- tests/e2e/Q-05.spec.ts`.
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const result = spawnSync('npx', ['playwright', 'test', '--project=perf', '--no-deps', ...process.argv.slice(2)], { stdio: 'inherit', shell: true, env: { ...process.env, CT_E2E_PERF: '1' } });
process.exit(result.status ?? 1);
