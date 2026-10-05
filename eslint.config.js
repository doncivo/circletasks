// Configuration ESLint (flat config). Frontières de couches : ADR 0001.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Motifs d'import d'une couche, en chemin relatif ou absolu. */
const layer = (name) => [`**/${name}`, `**/${name}/**`];

/** Blocs chargés à la demande (PERF-02, ADR 0001 avenant) : jamais d'import statique, seulement `import()` depuis leur chargeur. */
const ON_DEMAND_PATTERN = {
  group: ['**/domain/chronoAbsolute', '**/i18n/en'],
  message: 'Bloc chargé à la demande (PERF-02) : import() depuis src/features/capture/absoluteDatesLoader.ts ou src/i18n/index.ts seulement.',
};

/** Interdit l'import des couches listées depuis les fichiers ciblés. */
const forbidLayers = (files, layers, message) => ({
  files,
  ignores: ['**/*.test.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: layers.flatMap(layer), message },
          { group: ['@tauri-apps/*'], message: 'Les API Tauri ne s’importent que dans src/platform (ADR 0001).' },
          ON_DEMAND_PATTERN,
        ],
      },
    ],
  },
});

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'src-tauri/**', 'node_modules/**', '.claude/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Aucun texte d'interface en dur (CLAUDE.md, ADR 0003) : passer par t('…').
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXText[value=/\\p{L}/u]',
          message: 'Texte d’interface en dur : utiliser t() de src/i18n.',
        },
        {
          selector:
            'JSXAttribute[name.name=/^(aria-label|aria-description|title|placeholder|alt)$/] > Literal',
          message: 'Texte d’interface en dur : utiliser t() de src/i18n.',
        },
      ],
    },
  },
  // Frontières : domain → db → features → ui ; platform isole PC / iOS.
  forbidLayers(
    ['src/domain/**'],
    ['db', 'features', 'ui', 'sync', 'platform', 'i18n'],
    'src/domain est pur : aucune dépendance vers les autres couches.',
  ),
  forbidLayers(['src/db/**'], ['features', 'ui', 'sync', 'platform', 'i18n'], 'src/db ne dépend que de src/domain.'),
  forbidLayers(['src/sync/**'], ['features', 'ui'], 'src/sync ne dépend que de domain, db et platform.'),
  forbidLayers(['src/i18n/**'], ['db', 'features', 'ui', 'sync', 'platform'], 'src/i18n est autonome.'),
  forbidLayers(
    ['src/ui/**'],
    ['db', 'features', 'sync', 'platform'],
    'src/ui (design system) ne connaît que domain et i18n.',
  ),
  forbidLayers(
    ['src/features/**', 'src/App.tsx', 'src/main.tsx'],
    ['db/drivers', 'platform/tauri'],
    'Les features passent par src/platform et src/db/repositories, jamais par un driver.',
  ),
  {
    files: ['src/platform/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: [...layer('features'), ...layer('ui')] }, ON_DEMAND_PATTERN] }] },
  },
  // Reste de src/ (captureMain.tsx, etc.) : mêmes blocs à la demande.
  {
    files: ['src/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [ON_DEMAND_PATTERN] }] },
  },
  // sideEffects: ["**/*.css"] (package.json) : un import nu d'un module TS/JS serait élagué par le bundler (ADR 0001, avenant PERF-02).
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'JSXText[value=/\\p{L}/u]', message: 'Texte d’interface en dur : utiliser t() de src/i18n.' },
        {
          selector: 'JSXAttribute[name.name=/^(aria-label|aria-description|title|placeholder|alt)$/] > Literal',
          message: 'Texte d’interface en dur : utiliser t() de src/i18n.',
        },
        {
          selector: 'ImportDeclaration[specifiers.length=0]:not([source.value=/\\.css$/])',
          message: 'Import nu interdit : sideEffects (package.json) l’élaguerait ; appeler une fonction d’initialisation explicite.',
        },
      ],
    },
  },
  {
    files: ['*.config.{ts,js}', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-syntax': 'off' },
  },
);
