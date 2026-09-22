import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/track-cleanup/test/**/*.test.ts'],
    environment: 'node',
  },
});
