import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
# Same-origin proxy for go2rtc (stable MSE playback from the Vite origin)
    proxy: {
      '/go2rtc': {
        target: 'http://127.0.0.1:1984',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/go2rtc/, ''),
      },
    },
  },
})
