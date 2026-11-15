import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

/**
 * Dev only: serve the fine tile levels that are not in git (MOON_DATA/<name>_fine, written by
 * pipeline/dem_tiles.py, slope_tiles.py and sky_view.py) at /<name>-fine, so on-demand refinement
 * works locally. In production they come from a bucket (VITE_DEM_FINE_URL etc., see lib/pyramid.ts);
 * without one the app falls back to the shipped coarser levels.
 */
function fineTiles(): Plugin {
  const data = path.resolve(process.env.MOON_DATA ?? path.resolve(import.meta.dirname, '../../data'))
  return {
    name: 'fine-tiles',
    apply: 'serve',
    configureServer(server) {
      for (const name of ['dem', 'slope', 'sky']) {
        const root = path.join(data, `${name}_fine`)
        server.middlewares.use(`/${name}-fine`, (req, res) => {
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
      }
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
    fineTiles(),
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((dir) => ({
        src: `${cesiumSource}/${dir}`,
        dest: cesiumBaseUrl,
        rename: { stripBase: 4 }, // drop "node_modules/cesium/Build/Cesium" -> /cesiumStatic/Workers/...
      })),
    }),
  ],
})
