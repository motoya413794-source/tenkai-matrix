import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: '展開マトリクス',
        short_name: '展開',
        description: 'レース展開 × 脚質で馬を整理する',
        start_url: '/',
        display: 'standalone',
        background_color: '#f3efe4',
        theme_color: '#1d6b46',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ],
      },
    }),
  ],
})
