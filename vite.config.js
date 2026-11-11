import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  // The library ships pre-bundled ESM + wasm; excluding it keeps the dev worker stable.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
})