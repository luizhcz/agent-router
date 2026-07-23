// MOCK — stand-in para o servidor HTTP real (etapa 1)

const http = require('http')

class HttpServer {
    constructor() {
        this.middlewares = []
        this.routes = new Map() // key: 'METHOD /path' ou '* /path'
        this.server = null
        this.port = null
    }

    async initialize(conn) {
        this.port = parseInt(process.env.HTTP_PORT || process.env.PORT || '8080', 10)

        this.server = http.createServer((req, res) => {
            this._handle(req, res).catch((err) => {
                this._sendJson(res, 500, { error: (err && err.message) || 'internal error' })
            })
        })

        await new Promise((resolve) => {
            this.server.listen(this.port, () => {
                console.log(`[HttpServer] escutando em http://localhost:${this.port}/`)
                resolve()
            })
        })
    }

    use(fn) {
        this.middlewares.push(fn)
    }

    on(key, handler) {
        const { method, path } = this._parseKey(key)
        this.routes.set(`${method} ${path}`, handler)
    }

    _parseKey(key) {
        let method = '*'
        let rawPath = key

        const idx = key.indexOf(':')
        if (idx !== -1) {
            const maybeMethod = key.slice(0, idx).toUpperCase()
            if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'].includes(maybeMethod)) {
                method = maybeMethod
                rawPath = key.slice(idx + 1)
            }
        }

        return { method, path: this._normalizePath(rawPath) }
    }

    _normalizePath(p) {
        if (!p.startsWith('/')) p = '/' + p
        // remove trailing slash exceto raiz
        if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
        return p
    }

    _findRoute(method, path) {
        const exact = this.routes.get(`${method} ${path}`)
        if (exact) return exact
        const any = this.routes.get(`* ${path}`)
        if (any) return any
        return null
    }

    async _handle(req, res) {
        // CORS básico
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', '*')

        if (req.method === 'OPTIONS') {
            res.statusCode = 204
            res.end()
            return
        }

        const parsed = new URL(req.url, `http://localhost:${this.port}`)
        const path = this._normalizePath(parsed.pathname)

        // query string
        const query = {}
        for (const [k, v] of parsed.searchParams.entries()) query[k] = v

        // corpo
        const bodyRaw = await this._readBody(req)
        let body = {}
        if (bodyRaw && bodyRaw.length) {
            try {
                body = JSON.parse(bodyRaw)
            } catch (e) {
                body = {}
            }
        }

        // merge de data: query + corpo
        let data
        if (Array.isArray(body)) {
            data = body
        } else {
            data = Object.assign({}, query, body)
        }

        const mreq = {
            method: req.method,
            path,
            query,
            headers: req.headers || {},
            data,
            ack: (ms) => {
                try {
                    if (req.socket && typeof req.socket.setTimeout === 'function') {
                        req.socket.setTimeout((ms || 0) + 5000)
                    }
                } catch (e) {
                    // no-op seguro
                }
            }
        }

        const handler = this._findRoute(req.method, path)
        if (!handler) {
            this._sendJson(res, 404, { error: 'not found', path })
            return
        }

        // middlewares
        try {
            await this._runMiddlewares(mreq, res)
        } catch (e) {
            this._sendJson(res, 500, { error: (e && e.message) || 'middleware error' })
            return
        }

        if (res.writableEnded || res.headersSent) return

        // handler
        let result
        try {
            result = await handler(mreq)
        } catch (e) {
            this._sendJson(res, 500, { error: (e && e.message) || 'handler error' })
            return
        }

        this._sendResult(res, result)
    }

    _runMiddlewares(req, res) {
        return new Promise((resolve, reject) => {
            let i = 0
            const next = (err) => {
                if (err) return reject(err)
                if (i >= this.middlewares.length) return resolve()
                const fn = this.middlewares[i++]
                try {
                    fn(req, res, next)
                } catch (e) {
                    reject(e)
                }
            }
            next()
        })
    }

    _readBody(req) {
        return new Promise((resolve, reject) => {
            const chunks = []
            req.on('data', (c) => chunks.push(c))
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            req.on('error', reject)
        })
    }

    _sendResult(res, result) {
        if (result === undefined) {
            res.statusCode = 204
            res.end()
            return
        }

        if (result && typeof result === 'object' && result.type === 'file' && result.stream) {
            res.statusCode = 200
            res.setHeader('Content-Type', result.contentType || 'application/octet-stream')
            result.stream.on('error', () => {
                if (!res.headersSent) res.statusCode = 500
                res.end()
            })
            result.stream.pipe(res)
            return
        }

        // Envelope de status explícito: { type:'http', status, body }
        if (result && typeof result === 'object' && result.type === 'http') {
            this._sendJson(res, result.status || 200, result.body === undefined ? null : result.body)
            return
        }

        this._sendJson(res, 200, result)
    }

    _sendJson(res, status, payload) {
        if (res.writableEnded) return
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(payload))
    }
}

module.exports = { HttpServer }
