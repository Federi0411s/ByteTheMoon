import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

// CesiumJS ships workers, textures and widget CSS that must be served as static files.
// They are copied to /cesiumStatic at build time; index.html sets window.CESIUM_BASE_URL to match.
const cesiumSource = 'node_modules/cesium/Build/Cesium'
const cesiumBaseUrl = 'cesiumStatic'

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((dir) => ({
        src: `${cesiumSource}/${dir}`,
        dest: cesiumBaseUrl,
        rename: { stripBase: 4 }, // drop "node_modules/cesium/Build/Cesium" -> /cesiumStatic/Workers/...
      })),
    }),
  ],
})
