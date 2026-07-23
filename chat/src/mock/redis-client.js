// MOCK — stand-in para RedisClient (etapa 1)
// Cache in-memory (Map). initialize é no-op assíncrono; get/set/del/expire
// operam sobre o Map local. Não acessa rede/disco. Usado por serviços de domínio.

class RedisClient {

    constructor() {
        this.store = new Map()
        this.expirations = new Map()
    }

    async initialize(endpoint) {
        // no-op: nenhuma conexão real é aberta
        this.endpoint = endpoint
        return this
    }

    _expired(key) {
        const exp = this.expirations.get(key)
        if (exp !== undefined && Date.now() > exp) {
            this.store.delete(key)
            this.expirations.delete(key)
            return true
        }
        return false
    }

    async get(key) {
        if (this._expired(key)) {
            return null
        }
        return this.store.has(key) ? this.store.get(key) : null
    }

    async set(key, value, ttlSeconds) {
        this.store.set(key, value)
        if (ttlSeconds) {
            this.expirations.set(key, Date.now() + ttlSeconds * 1000)
        } else {
            this.expirations.delete(key)
        }
        return 'OK'
    }

    async del(key) {
        const existed = this.store.delete(key)
        this.expirations.delete(key)
        return existed ? 1 : 0
    }

    async expire(key, ttlSeconds) {
        if (!this.store.has(key)) {
            return 0
        }
        this.expirations.set(key, Date.now() + ttlSeconds * 1000)
        return 1
    }
}

module.exports = { RedisClient }
