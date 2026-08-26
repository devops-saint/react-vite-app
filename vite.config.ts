import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react({
      jsxImportSource: '@emotion/react',
      babel: {
        plugins: ['@emotion/babel-plugin'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@api': path.resolve(import.meta.dirname, './src/api'),
      '@auth': path.resolve(import.meta.dirname, './src/auth'),
      '@assets': path.resolve(import.meta.dirname, './src/assets'),
      '@components': path.resolve(import.meta.dirname, './src/components'),
      '@config': path.resolve(import.meta.dirname, './src/config'),
      '@constants': path.resolve(import.meta.dirname, './src/constants'),
      '@contexts': path.resolve(import.meta.dirname, './src/contexts'),
      '@features': path.resolve(import.meta.dirname, './src/features'),
      '@hooks': path.resolve(import.meta.dirname, './src/hooks'),
      '@layouts': path.resolve(import.meta.dirname, './src/layouts'),
      '@pages': path.resolve(import.meta.dirname, './src/pages'),
      '@routes': path.resolve(import.meta.dirname, './src/routes'),
      '@services': path.resolve(import.meta.dirname, './src/services'),
      '@theme': path.resolve(import.meta.dirname, './src/theme'),
      '@types': path.resolve(import.meta.dirname, './src/types'),
      '@utils': path.resolve(import.meta.dirname, './src/utils'),
    },
  },
  server: {
    port: 3000,
    host: true,
    strictPort: true,
    open: true,
  },
  preview: {
    port: 3000,
    host: true,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router-dom')) {
              return 'react-vendor';
            }
            if (id.includes('@mui') || id.includes('@emotion')) {
              return 'mui-vendor';
            }
            if (id.includes('@tanstack/react-query')) {
              return 'query-vendor';
            }
            if (id.includes('@azure/msal')) {
              return 'msal-vendor';
            }
          }
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router-dom',
      '@mui/material',
      '@mui/icons-material',
      '@emotion/react',
      '@emotion/styled',
      '@tanstack/react-query',
      '@azure/msal-browser',
      '@azure/msal-react',
    ],
  },
});
