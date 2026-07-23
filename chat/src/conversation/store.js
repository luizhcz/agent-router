// Store do registro de conversa (config durável: versão + agentes + dono).
// Abstração sobre um cliente Redis (mock hoje, real depois). O ESTADO TRANSIENTE
// (mensagens, memória do agente) NÃO vive aqui — fica em runtime.contexts, em
// memória, chaveado pelo mesmo conversationId. Ver docs/design-notes.md (Parte 2).

const crypto = require('crypto')

const PREFIX = 'conversation:'
const DEFAULT_TTL_SECONDS = 8 * 60 * 60 // 8h de inatividade

class ConversationStore {
    constructor(redis, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
        this.redis = redis
        this.ttlSeconds = ttlSeconds
    }

    // Token opaco de alta entropia (capability). Nunca sequencial/adivinhável.
    _mintId() {
        return 'conv_' + crypto.randomBytes(18).toString('base64url')
    }

    _key(id) {
        return PREFIX + id
    }

    async _put(rec) {
        await this.redis.set(this._key(rec.id), JSON.stringify(rec), this.ttlSeconds)
        return rec
    }

    async create(config) {
        const id = this._mintId()
        const now = Date.now()
        const rec = {
            id,
            version: config.version,
            agents: config.agents,
            owner: config.owner,
            status: 'active',
            createdAt: now,
            lastActivityAt: now,
            expiresAt: now + this.ttlSeconds * 1000,
        }
        return this._put(rec)
    }

    async get(id) {
        if (!id) return null
        const raw = await this.redis.get(this._key(id))
        if (!raw) return null
        try {
            return JSON.parse(raw)
        } catch {
            return null
        }
    }

    // Renova TTL + lastActivityAt a cada uso (janela deslizante de inatividade).
    async touch(id) {
        const rec = await this.get(id)
        if (!rec) return null
        rec.lastActivityAt = Date.now()
        rec.expiresAt = rec.lastActivityAt + this.ttlSeconds * 1000
        return this._put(rec)
    }

    async close(id) {
        const rec = await this.get(id)
        if (!rec) return null
        rec.status = 'closed'
        return this._put(rec)
    }

    async delete(id) {
        await this.redis.del(this._key(id))
    }
}

module.exports = { ConversationStore }
