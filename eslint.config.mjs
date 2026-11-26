import pluginJs from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['dist/**', 'builds/**', 'node_modules/**', '.claude/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', '*.ts', '*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  perfectionist.configs['recommended-alphabetical'],
  {
    rules: {
      // Express handlers are typed `Request<{}, ...>`, the library's own idiom.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'padding-line-between-statements': [
        'error',
        { blankLine: 'always', next: 'if', prev: '*' },
      ],
      // Only sort what cannot change runtime behaviour. Import and export
      // statement order is module load order (index.ts relies on it, and some
      // modules import each other); key, case and member order can change what
      // prints. Names inside braces and type members are still sorted.
      'perfectionist/sort-array-includes': 'off',
      'perfectionist/sort-classes': 'off',
      'perfectionist/sort-exports': 'off',
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-maps': 'off',
      'perfectionist/sort-modules': 'off',
      'perfectionist/sort-objects': 'off',
      'perfectionist/sort-sets': 'off',
      'perfectionist/sort-switch-case': 'off',
    },
  },
  // Formatting is Prettier's job (`npm run format:check`).
  prettierConfig,
];
