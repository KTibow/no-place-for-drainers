import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ktibow.github.io',
  base: '/no-place-for-drainers',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
