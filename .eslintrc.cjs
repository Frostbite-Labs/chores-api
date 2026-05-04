/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: './tsconfig.json' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  },
  overrides: [
    {
      // Enforces types/ stays declaration-only.
      // No runtime imports from src/, no non-type exports, no value declarations.
      files: ['types/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          { patterns: [{ group: ['../src/*', '@/*'], message: 'types/ must not import runtime code from src/.' }] },
        ],
        '@typescript-eslint/no-restricted-syntax': 'off',
        'no-restricted-syntax': [
          'error',
          { selector: "ExportNamedDeclaration[exportKind!='type'] > VariableDeclaration", message: 'types/ may only export types.' },
          { selector: "ExportNamedDeclaration[exportKind!='type'] > FunctionDeclaration", message: 'types/ may only export types.' },
          { selector: "ExportNamedDeclaration[exportKind!='type'] > ClassDeclaration", message: 'types/ may only export types.' },
          { selector: 'ExportDefaultDeclaration', message: 'types/ may not have default exports.' },
        ],
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', '*.cjs'],
};
