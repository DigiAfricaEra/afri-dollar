module.exports = {
  extends: '../../.eslintrc.js',
  rules: {
    'no-console': 'off',
    // Disable type-aware rules that produce false positives with Stellar SDK/Prisma/Express types
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    // Prisma-generated types include `any` in intersection types
    '@typescript-eslint/no-redundant-type-constituents': 'off',
    // Prisma returns are thenable and don't need explicit await
    '@typescript-eslint/require-await': 'off',
  },
};
