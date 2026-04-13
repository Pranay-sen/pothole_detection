import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/static/frontend/',
  plugins: [react()],
  build: {
    outDir: '../static/frontend',
    emptyOutDir: true,
  },
})
