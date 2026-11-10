import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import http from 'http'
import https from 'https'
import { URL } from 'url'

// The backend binds 127.0.0.1; "localhost" may resolve to ::1 first on newer
// Node versions, which makes every proxied request time out.
const BACKEND = process.env.AUTOLOGY_BACKEND_URL || 'http://127.0.0.1:8000'

function dynamicOllamaProxy() {
  return {
    name: 'dynamic-ollama-proxy',
    configureServer(server) {
      server.middlewares.use('/ollama-proxy', (req, res) => {
        const targetBase = req.headers['x-ollama-target'] || 'http://localhost:11434'
        const apiPath = req.url || '/'

        let target
        try {
          target = new URL(apiPath, targetBase)
        } catch {
          res.writeHead(400)
          res.end('Bad target URL')
          return
        }

        const isHttps = target.protocol === 'https:'
        const transport = isHttps ? https : http

        const chunks = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          const options = {
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: target.pathname + target.search,
            method: req.method,
            headers: {
              'Content-Type': req.headers['content-type'] || 'application/json',
              'Content-Length': body.length,
            },
          }

          const proxyReq = transport.request(options, proxyRes => {
            res.writeHead(proxyRes.statusCode, {
              'Content-Type': proxyRes.headers['content-type'] || 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Transfer-Encoding': proxyRes.headers['transfer-encoding'] || '',
            })
            proxyRes.pipe(res)
          })

          proxyReq.setTimeout(300000, () => {
            proxyReq.destroy()
            if (!res.headersSent) {
              res.writeHead(504)
              res.end(JSON.stringify({ error: 'Gateway timeout' }))
            }
          })

          proxyReq.on('error', err => {
            if (!res.headersSent) {
              res.writeHead(502)
              res.end(JSON.stringify({ error: err.message }))
            }
          })

          proxyReq.write(body)
          proxyReq.end()
        })
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), dynamicOllamaProxy()],
  server: {
    port: 5173,
    host: true,
    allowedHosts: ['chojungwon.iptime.org'],
    proxy: {
      '/api/crew': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/api/semantic': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/api/ollama': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/api/memory': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/api/vocabulary': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/api/entities': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/api/knowledge': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/api/explore': {
        target: BACKEND,
        changeOrigin: true,
      },
      '/ws/crew': {
        target: BACKEND.replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
      },
      '/health': {
        target: BACKEND,
        changeOrigin: true,
      },
    },
  },
})
