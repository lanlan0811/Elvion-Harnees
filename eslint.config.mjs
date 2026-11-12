import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.codex/**', '.cache/**', 'artifacts/**', 'packages/platform-*/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.ts', '**/*.tsx'], rules: { 'no-control-regex': 'off', '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-this-alias': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', fetch: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } } }
);
