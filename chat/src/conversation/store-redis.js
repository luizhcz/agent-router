// Store de CACHE da conversa, sobre um cliente Redis. É o caminho quente da
// resolução por mensagem (rápido + TTL). NÃO é a fonte da verdade — o durável
// (Postgres) é. `save/load/remove` de baixo nível; o lifecycle (mint/status/TTL)
// mora no WriteThroughStore.

const PREFIX = 'conversation:'
const DEFAULT_TTL_SECONDS = 8 * 60 * 60

class RedisConversationStore {
    constructor(redis, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
        this.redis = redis
        this.ttlSeconds = ttlSeconds
    }

    _key(id) {
        return PREFIX + id
    }

    async save(record) {
        await this.redis.set(this._key(record.id), JSON.stringify(record), this.ttlSeconds)
        return record
    }

    async load(id) {
        if (!id) return null
        const raw = await this.redis.get(this._key(id))
        if (!raw) return null
        try {
            return JSON.parse(raw)
        } catch {
            return null
        }
    }

    async remove(id) {
        await this.redis.del(this._key(id))
    }
}

module.exports = { RedisConversationStore, DEFAULT_TTL_SECONDS }
