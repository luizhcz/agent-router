// Regras de negócio da conversa: validação na criação e resolução com authz.
// A conversa é um RECURSO PROVISIONADO: o cliente cria passando versão + agentes;
// o servidor cunha um id opaco e guarda a config (versão/agentes/dono). As mensagens
// seguintes só carregam o id e o servidor resolve o resto do registro.

const { Utils } = require('../utils')
const { HttpError } = require('./errors')

class ConversationService {
    constructor({ store, availableAgents, defaultVersion }) {
        this.store = store
        this.availableAgents = availableAgents || [] // ex.: ['trader','content']
        this.defaultVersion = defaultVersion
    }

    /**
     * Cria a conversa. `owner` vem da identidade autenticada (derivada dos headers).
     * `version` é FIXADA aqui (imutável por conversa); omitida => latest. `agents`
     * omitido/vazio => todos os disponíveis. Lança HttpError em entrada inválida.
     */
    async create({ version, agents, owner }) {
        if (!owner || !owner.mode) {
            throw new HttpError(400, 'identidade do dono ausente')
        }

        // versão: valida semver se informada; senão usa a padrão (latest)
        let v = version
        if (v != null && v !== '') {
            if (!Utils.isValidVersion(String(v))) {
                throw new HttpError(400, `versão inválida: ${v}`)
            }
            v = String(v).trim()
        } else {
            v = this.defaultVersion
        }

        // agentes: default = todos; valida contra os disponíveis
        let ags = agents
        if (ags == null || (Array.isArray(ags) && ags.length === 0)) {
            ags = [...this.availableAgents]
        }
        if (!Array.isArray(ags)) {
            throw new HttpError(400, 'agents deve ser uma lista')
        }
        const unknown = ags.filter(a => !this.availableAgents.includes(a))
        if (unknown.length) {
            throw new HttpError(400, `agente(s) desconhecido(s): ${unknown.join(', ')}. Disponíveis: ${this.availableAgents.join(', ')}`)
        }
        // (hook) gating por modo: nenhum agente é admin-only por ora. Se algum vier a
        // ser, rejeitar aqui com 403 quando owner.mode não puder usá-lo.

        return this.store.create({ version: v, agents: ags, owner })
    }

    /**
     * Resolve o registro pelo id + verifica que a identidade autenticada é a dona.
     * Renova o TTL. Lança HttpError (404 ausente/expirada, 410 encerrada, 403 sem acesso).
     */
    async resolve(conversationId, authIdentity) {
        if (!conversationId) {
            throw new HttpError(400, 'conversation-id ausente')
        }
        const rec = await this.store.get(conversationId)
        if (!rec) {
            throw new HttpError(404, 'conversa não encontrada ou expirada')
        }
        if (rec.status !== 'active') {
            throw new HttpError(410, 'conversa encerrada')
        }
        if (!this._ownerMatches(rec.owner, authIdentity)) {
            throw new HttpError(403, 'sem acesso a esta conversa')
        }
        return this.store.touch(conversationId).then(() => rec)
    }

    async close(conversationId) {
        return this.store.close(conversationId)
    }

    _ownerMatches(owner, auth) {
        if (!owner || !auth || owner.mode !== auth.mode) return false
        if (owner.mode === 'digital') return !!owner.account && owner.account === auth.account
        if (owner.mode === 'admin') return !!owner.userProfileId && owner.userProfileId === auth.userProfileId
        return false
    }
}

module.exports = { ConversationService }
