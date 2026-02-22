import neostandard from 'neostandard'

export default [
  ...neostandard({ ts: true }),
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // ── No else / else if ──
      'no-restricted-syntax': [
        'error',
        {
          selector: 'IfStatement[alternate!=null]',
          message: 'else and else if are banned. Use early returns or guard clauses instead.',
        },
      ],

      // ── No any ──
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Relax strict type rules in tests — mocks and fixtures often need `any`
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'scripts/**'],
  },
]
