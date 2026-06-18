module.exports = {
  extends: ['next/core-web-vitals', '../../.eslintrc.js'],
  parserOptions: {
    // Use the frontend tsconfig which includes DOM lib types
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    '@next/next/no-html-link-for-pages': 'off',
    // DOM APIs are typed as 'error' when root tsconfig is used (no DOM lib)
    // The frontend tsconfig includes DOM, but lint-staged may use root context
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
  },
};
