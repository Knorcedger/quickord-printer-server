import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest', // use ts-jest instead of swc
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'], // looks for tests in /test
};

export default config;
