import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // 用相对路径，方便直接放到任意静态服务器或子目录
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          // tesseract 体积较大且只在识别时才需要，单独分包，首屏更快
          ocr: ['tesseract.js'],
          pinyin: ['pinyin-pro']
        }
      }
    }
  },
  server: {
    port: 5173,
    host: true
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*', 'tessdata/*', 'tesseract/*'],
      manifest: {
        name: '自动听写 · 拍照出词，念给孩子听',
        short_name: '自动听写',
        description: '拍照识别书本词语，自动标注拼音，按自定义次数和间隔播报给孩子听写。',
        lang: 'zh-CN',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f4f6fb',
        theme_color: '#3b6ef5',
        icons: [
          { src: './icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // 语言模型与 wasm 都放进缓存，断网也能识别
        globPatterns: ['**/*.{js,css,html,svg,png,ico,gz,wasm,traineddata}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /tessdata\/.*\.traineddata\.gz$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tessdata',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 }
            }
          }
        ]
      },
      devOptions: {
        enabled: false
      }
    })
  ]
});
