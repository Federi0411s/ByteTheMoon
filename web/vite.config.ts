import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

/**
 * Dev only: serve the fine elevation tiles (pipeline/dem_tiles.py -> MOON_DATA/dem_fine, ~2 GB, not
 * in git) at /dem-fine, so on-demand refinement works locally. In production they come from a bucket
 * (VITE_DEM_FINE_URL); without one the app falls back to the shipped 666 m tiles.
 */
function demFine(): Plugin {
  const root = path.resolve(process.env.MOON_DATA ?? path.resolve(import.meta.dirname, '../../data'), 'dem_fine')
  return {
    name: 'dem-fine',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/dem-fine', (req, res) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0])
        const file = path.join(root, rel)
        if (!/^\/\d+\/\d+\/\d+\.webp$/.test(rel) || !file.startsWith(root) || !existsSync(file)) {
          res.statusCode = 404
          res.end()
          return
        }
        res.setHeader('Content-Type', 'image/webp')
        res.setHeader('Content-Length', statSync(file).size)
        res.setHeader('Cache-Control', 'public, max-age=86400')
        createReadStream(file).pipe(res)
      })
    },
  }
}

// CesiumJS ships workers, textures and widget CSS that must be served as static files.
// They are copied to /cesiumStatic at build time; index.html sets window.CESIUM_BASE_URL to match.
const cesiumSource = 'node_modules/cesium/Build/Cesium'
const cesiumBaseUrl = 'cesiumStatic'

export default defineConfig({
  // the browser reads pipeline/equipot_results.csv directly (single source for the charging model)
  server: { fs: { allow: ['..'] } },
  plugins: [
    react(),
    demFine(),
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((dir) => ({
        src: `${cesiumSource}/${dir}`,
        dest: cesiumBaseUrl,
        rename: { stripBase: 4 }, // drop "node_modules/cesium/Build/Cesium" -> /cesiumStatic/Workers/...
      })),
    }),
  ],
})
