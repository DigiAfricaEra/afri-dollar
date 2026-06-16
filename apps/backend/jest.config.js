/* eslint-env node */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.ts', '**/tests/integration/**/*.test.ts'],
  moduleNameMapper: {
    '^@afri-dollar/database$': '<rootDir>/../../packages/database/src/index.ts',
    '^@afri-dollar/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
};
