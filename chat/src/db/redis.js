// Cliente Redis REAL (node-redis v4). Expõe a MESMA interface do mock
// src/mock/redis-client.js — `initialize(url)` + get / set(key,val,ttlSeconds) /
// del / expire — então o RedisConversationStore não muda ao trocar o mock por este.
// Usado quando REDIS_CONVERSATION_ENDPOINT está no .env.

const { createClient } = require('redis')

class RedisClient {
    async initialize(url) {
        this.client = createClient({ url })
        this.client.on('error', (e) => console.error('[redis] client error:', e.message))
        await this.client.connect()
        return this
    }

    async get(key) {
        return this.client.get(key) // string ou null
    }

    async set(key, value, ttlSeconds) {
        if (ttlSeconds) return this.client.set(key, value, { EX: ttlSeconds })
        return this.client.set(key, value)
    }

    async del(key) {
        return this.client.del(key)
    }

    async expire(key, ttlSeconds) {
        return this.client.expire(key, ttlSeconds)
    }

    async quit() {
        if (this.client) await this.client.quit()
    }
}

module.exports = { RedisClient }
