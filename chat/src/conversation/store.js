// Store de conversa com WRITE-THROUGH: o durável (Postgres) é a FONTE DA VERDADE
// e o cache (Redis) é o caminho quente. Este objeto é dono do lifecycle do
// registro (mint do id opaco, status, timestamps, TTL) e orquestra os dois
// sub-stores (que só sabem save/load/remove). O ConversationService fala só com
// esta interface (create/get/touch/close/delete), então trocar a persistência
// não toca o service. Ver docs/design-notes.md (Parte 2, "Armazenamento").

const crypto = require('crypto')
const { DEFAULT_TTL_SECONDS } = require('./store-redis')

function mintId() {
    // Token opaco de alta entropia (capability). Nunca sequencial/adivinhável.
    return 'conv_' + crypto.randomBytes(18).toString('base64url')
}

class WriteThroughStore {
    constructor({ durable, cache, ttlSeconds = DEFAULT_TTL_SECONDS }) {
        this.durable = durable // Postgres — fonte da verdade
        this.cache = cache // Redis — cache quente
        this.ttlSeconds = ttlSeconds
    }

    _newRecord(config) {
        const now = Date.now()
        return {
            id: mintId(),
            version: config.version,
            agents: config.agents,
            owner: config.owner,
            status: 'active',
            createdAt: now,
            lastActivityAt: now,
            expiresAt: now + this.ttlSeconds * 1000,
        }
    }

    async create(config) {
        const record = this._newRecord(config)
        await this.durable.save(record) // grava no banco primeiro (fonte da verdade)
        await this.cache.save(record) // aquece o cache
        return record
    }

    async get(id) {
        let record = await this.cache.load(id)
        if (record) return record
        // miss no cache (expirou/restart do Redis) => banco, e reaquece o cache
        record = await this.durable.load(id)
        if (record) await this.cache.save(record)
        return record
    }

    async touch(id) {
        const record = await this.get(id)
        if (!record) return null
        record.lastActivityAt = Date.now()
        record.expiresAt = record.lastActivityAt + this.ttlSeconds * 1000
        await this.durable.save(record)
        await this.cache.save(record)
        return record
    }

    async close(id) {
        const record = await this.get(id)
        if (!record) return null
        record.status = 'closed'
        await this.durable.save(record)
        await this.cache.save(record)
        return record
    }

    async delete(id) {
        await this.durable.remove(id)
        await this.cache.remove(id)
    }
}

module.exports = { WriteThroughStore, mintId }
