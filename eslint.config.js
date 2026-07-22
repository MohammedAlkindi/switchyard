import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // public/ is the static website (DOM code with its own tsconfig), not CLI source.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
