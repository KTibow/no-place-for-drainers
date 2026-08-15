import { defineConfig } from 'astro/config';

export default defineConfig({
  // Project pages inherit the account's custom domain.
  site: 'https://kendell.dev',
  base: '/no-place-for-drainers',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
