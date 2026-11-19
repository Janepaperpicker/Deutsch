import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = process.env.DEUTSCH_API_PORT
    || env.DEUTSCH_API_PORT
    || process.env.PORT
    || env.PORT
    || '3001'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/optional-voice': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
        '/socket.io': { target: `http://127.0.0.1:${apiPort}`, ws: true, changeOrigin: false },
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: false,
        },
      },
    },
  }
})
