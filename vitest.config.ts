import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

export default defineConfig((configEnv) => mergeConfig(
  viteConfig(configEnv),
  {
    server: {
      fs: {
        allow: [fileURLToPath(new URL('.', import.meta.url)), realpathSync(new URL('node_modules', import.meta.url))],
      },
    },
    define: {
      APP_REVISION: JSON.stringify('vitest-test'),
      APP_VERSION: JSON.stringify('0.0.1'),
    },
    test: {
      environment: 'jsdom',
      exclude: [
        ...configDefaults.exclude,
        'tests/playwright/**',
        'scripts/**/*.test.mjs',
        'scripts/**/*.test.cjs',
        'docs/**',
      ],
      setupFiles: ['./src/testSetup.ts'],
    },
  },
));
