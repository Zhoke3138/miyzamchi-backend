import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      include: ['path', 'fs', 'module', 'crypto', 'stream', 'util', 'os', 'events', 'assert', 'zlib', 'buffer', 'process', 'url', 'http', 'https']
    })
  ],
  optimizeDeps: {
    entries: ['index.html']
  }
});
