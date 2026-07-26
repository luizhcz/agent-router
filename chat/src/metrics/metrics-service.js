// Serviço de MÉTRICAS + AUDITORIA sobre o Postgres (frio). Só-leitura.
//
// - all(): roda os KPIs do catálogo (metrics/catalog.js) -> painel de KPIs.
// - listConversations(): as N conversas mais recentes (DESC) para a aba Conversas.
// - reconstructConversation(id): reconstrói UMA conversa POR INTEIRO (o diálogo +
//   os comandos, chamadas de LLM e ordens de cada turno) para auditoria.
// - exportForJudge(id): reshape da reconstrução num artefato enxuto e auto-descritivo
//   pronto para mandar a uma LLM-as-a-judge (transcript + sinais + capacidades + rubrica).
//
// Queries analíticas -> exigem o Postgres REAL; best-effort (falha -> vazio, não quebra).

const { CATALOG, PERIODS } = require('./catalog')

// Versão do formato de export (deixa o consumidor/juiz saber o shape esperado).
const EXPORT_SCHEMA = 'trader-chat.judge-export/v1'

// Rubrica embutida no export: instrui a LLM-as-a-judge e fixa o schema do veredito,
// para o artefato ser auto-contido (basta colar num LLM). Em pt-BR (o chat é pt-BR).
const JUDGE_RUBRIC = {
    instrucao: 'Você é um juiz de qualidade de atendimento. Avalie a conversa abaixo (agente virtual de investimentos, pt-BR) do ponto de vista do usuário. Use `capabilities` para saber o que o agente PODE fazer: recusar/ignorar algo FORA dessa lista não é falha; já um pedido DENTRO dela que virou notFound ou erro É falha.',
    criterios: [
        'resolucao: o agente resolveu a intenção do usuário ao final da conversa?',
        'reconhecimento: entendeu os pedidos (poucos notFound indevidos)?',
        'correcao: os comandos executados condizem com o que foi pedido?',
        'clareza_tom: respostas claras, corretas em pt-BR e com tom adequado?',
        'escopo: recusas/limitações foram legítimas (pedido fora de capabilities)?',
        'seguranca: em ordens (enviar/cancelar), houve coerência e nada arriscado?',
    ],
    schema_veredito: {
        nota: 'inteiro 1..5 (1=péssima, 5=excelente)',
        resolvido: 'boolean',
        resumo: 'string curta em pt-BR',
        pontos_fortes: ['string'],
        problemas: ['string'],
        turnos_problematicos: ['seq (inteiro) dos turnos ruins'],
        risco: 'baixo|medio|alto',
    },
}

// Catálogo de CAPACIDADES do agente trader: os nomes dos comandos decorados com
// tool() no trader-agent.js (o que ele SABE fazer). O juiz usa isso para separar
// "recusa legítima (fora de escopo)" de "falha (deveria conseguir)". Enumerado uma
// única vez — o require só define a classe + metadados no protótipo, sem I/O.
let _capabilities = null
function agentCapabilities() {
    if (_capabilities) return _capabilities
    try {
        const { TraderAgent } = require('../trader-agent')
        const proto = TraderAgent.prototype
        _capabilities = Object.getOwnPropertyNames(proto)
            .filter(k => typeof proto[k] === 'function' && proto[k].toolName)
            .map(k => proto[k].toolName)
            .sort()
    } catch (e) {
        console.error('[Metrics] catálogo de capacidades indisponível:', e && e.message)
        _capabilities = []
    }
    return _capabilities
}

// Mascara PII estrutural (conta/perfil): mantém os 4 últimos dígitos. null -> null.
function maskId(v) {
    if (v == null || v === '') return null
    const s = String(v)
    return s.length <= 4 ? '****' : '*'.repeat(Math.min(4, s.length - 4)) + s.slice(-4)
}

// Mediana de uma lista numérica (ignora null/NaN). Lista vazia -> null.
function median(nums) {
    const a = nums.filter(n => n != null && !isNaN(n)).map(Number).sort((x, y) => x - y)
    if (!a.length) return null
    const m = Math.floor(a.length / 2)
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

class MetricsService {
    constructor(pg) {
        this.pg = pg
    }

    /**
     * Roda os KPIs do catálogo para um PERÍODO (1d/1w/1m/3m). Cada SQL recebe
     * $1 = cutoff (epoch-ms) e conta só o que tem created_at >= cutoff.
     * Devolve { periods, period, cutoff, sections, headline, kpis:[{...meta, rows}] }.
     */
    async all(period = '1m') {
        const p = PERIODS.find(x => x.id === period) || PERIODS.find(x => x.id === '1m')
        const cutoff = Date.now() - p.days * 86400000
        const kpis = []
        for (const k of CATALOG.kpis) {
            let rows = []
            try {
                rows = (await this.pg.query(k.sql, [cutoff])).rows || []
            } catch (e) {
                console.error(`[Metrics] KPI ${k.id} falhou:`, e && e.message)
            }
            kpis.push({
                id: k.id, name: k.name, section: k.section, question: k.question,
                viz: k.viz, good_direction: k.good_direction, format: k.format, rows,
            })
        }
        return { periods: CATALOG.periods, period: p.id, cutoff, sections: CATALOG.sections, headline: CATALOG.headline, kpis, generatedAt: Date.now() }
    }

    /**
     * As `limit` conversas mais recentes (created_at DESC) com um resumo por conversa
     * para a lista de auditoria: dono, versão, status, nº de turns, notFound, ordens e
     * o texto da última mensagem do usuário.
     */
    async listConversations(limit = 50) {
        try {
            const res = await this.pg.query(
                `SELECT c.id, c.owner_mode, c.owner_account, c.owner_user_profile_id, c.version, c.status,
                        c.created_at, c.last_activity_at,
                        (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turns,
                        (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id AND t.is_not_found) AS not_found,
                        (SELECT COUNT(*) FROM order_events oe WHERE oe.conversation_id = c.id) AS orders,
                        (SELECT t.user_text FROM turns t WHERE t.conversation_id = c.id ORDER BY t.seq DESC LIMIT 1) AS last_user_text
                 FROM conversations c
                 ORDER BY c.created_at DESC
                 LIMIT $1`,
                [limit]
            )
            return res.rows || []
        } catch (e) {
            console.error('[Metrics] listConversations falhou:', e && e.message)
            return []
        }
    }

    /**
     * Reconstrói UMA conversa por inteiro para auditoria: o registro + cada turno em
     * ordem (com o texto do usuário e do agente) e, aninhados no turno, os comandos
     * executados e as chamadas de LLM; e as ordens (order_events) da conversa.
     */
    async reconstructConversation(id) {
        const empty = { conversation: null, turns: [], orders: [] }
        if (!id) return empty
        try {
            const conv = (await this.pg.query(`SELECT * FROM conversations WHERE id = $1`, [id])).rows[0]
            if (!conv) return empty

            const turns = (await this.pg.query(
                `SELECT id, seq, user_text, agent_text, state, next_state, is_not_found, errored,
                        interrupt, interrupt_type, had_output_card, output_card_type, total_latency_ms, created_at
                 FROM turns WHERE conversation_id = $1 ORDER BY seq NULLS FIRST, created_at`, [id]
            )).rows

            const cmds = (await this.pg.query(
                `SELECT ce.turn_id, ce.seq, ce.command_method, ce.agent, ce.result_status
                 FROM command_executions ce JOIN turns t ON t.id = ce.turn_id
                 WHERE t.conversation_id = $1 ORDER BY ce.seq NULLS FIRST, ce.created_at`, [id]
            )).rows

            const llm = (await this.pg.query(
                `SELECT lc.turn_id, lc.mode, lc.model, lc.latency_ms, lc.parse_ok
                 FROM llm_calls lc JOIN turns t ON t.id = lc.turn_id
                 WHERE t.conversation_id = $1 ORDER BY lc.created_at`, [id]
            )).rows

            const orders = (await this.pg.query(
                `SELECT event_type, order_id, symbol, side, quantity, price, reason, created_at
                 FROM order_events WHERE conversation_id = $1 ORDER BY created_at`, [id]
            )).rows

            // aninha comandos e chamadas de LLM em cada turno (por turn_id)
            const cmdByTurn = {}, llmByTurn = {}
            for (const c of cmds) { (cmdByTurn[c.turn_id] || (cmdByTurn[c.turn_id] = [])).push(c) }
            for (const l of llm) { (llmByTurn[l.turn_id] || (llmByTurn[l.turn_id] = [])).push(l) }
            for (const t of turns) {
                t.commands = cmdByTurn[t.id] || []
                t.llm_calls = llmByTurn[t.id] || []
                delete t.id // id interno não interessa ao cliente
            }

            const conversation = {
                id: conv.id,
                owner: { mode: conv.owner_mode, account: conv.owner_account, userProfileId: conv.owner_user_profile_id },
                version: conv.version,
                status: conv.status,
                agents: typeof conv.agents === 'string' ? JSON.parse(conv.agents) : (conv.agents ?? []),
                createdAt: Number(conv.created_at),
                lastActivityAt: Number(conv.last_activity_at),
                expiresAt: Number(conv.expires_at),
            }
            return { conversation, turns, orders }
        } catch (e) {
            console.error('[Metrics] reconstructConversation falhou:', e && e.message)
            return empty
        }
    }

    /**
     * Exporta UMA conversa num artefato enxuto e AUTO-DESCRITIVO, pronto para mandar
     * a uma LLM-as-a-judge. Reaproveita reconstructConversation e reshapa em:
     *  - transcript: diálogo em ordem (usuário/agente) + o que foi mostrado/executado;
     *  - actions/outcomes: o que o agente FEZ e o desfecho (ordens, notFound, erros);
     *  - capabilities: o que o agente PODE fazer (separa recusa legítima de falha);
     *  - signals: métricas pré-computadas (latência mediana, taxa de notFound, resolvido);
     *  - judge: a rubrica + o schema do veredito (o artefato vira colável em qualquer LLM).
     * PII estrutural (conta/perfil) é mascarada; o texto das mensagens vai verbatim
     * (o juiz precisa dele). Retorna { schema, error } se a conversa não existir.
     */
    async exportForJudge(id) {
        const { conversation, turns, orders } = await this.reconstructConversation(id)
        if (!conversation) return { schema: EXPORT_SCHEMA, conversationId: id, error: 'conversa não encontrada' }

        const flagsOf = t => {
            const f = []
            if (t.errored) f.push('erro')
            if (t.interrupt) f.push('interrupt' + (t.interrupt_type ? ':' + t.interrupt_type : ''))
            return f
        }
        const transcript = turns.map(t => ({
            seq: t.seq == null ? null : Number(t.seq),
            user: t.user_text || null,
            agent: t.agent_text || null,
            recognized: !t.is_not_found,
            shown: t.had_output_card ? (t.output_card_type || 'card') : null,
            commands: (t.commands || []).map(c => `${c.command_method}:${c.result_status}`),
            latencyMs: t.total_latency_ms != null ? Math.round(t.total_latency_ms) : null,
            flags: flagsOf(t),
        }))

        // agregado do que o agente USOU: método -> nº de usos e nº de misses (notFound/erro).
        // Mapa SEM protótipo: command_method vem de dados e poderia colidir com membros de
        // Object.prototype (__proto__/toString/…), corrompendo a contagem e poluindo o protótipo.
        const usage = Object.create(null)
        for (const t of turns) for (const c of (t.commands || [])) {
            const u = usage[c.command_method] || (usage[c.command_method] = { method: c.command_method, count: 0, misses: 0 })
            u.count++
            if (c.result_status === 'not_found' || c.result_status === 'error') u.misses++
        }

        const notFoundTurns = turns.filter(t => t.is_not_found).length
        const erroredTurns = turns.filter(t => t.errored).length
        const last = turns[turns.length - 1]
        const ordersSent = orders.filter(o => o.event_type === 'ORDER_SENT').length
        const ordersCanceled = orders.filter(o => o.event_type === 'ORDER_CANCELED').length

        return {
            schema: EXPORT_SCHEMA,
            conversationId: conversation.id,
            meta: {
                agent: (Array.isArray(conversation.agents) && conversation.agents[0]) || 'trader',
                agents: conversation.agents,
                version: conversation.version,
                channel: conversation.owner.mode,
                account: maskId(conversation.owner.account),
                userProfileId: maskId(conversation.owner.userProfileId),
                turns: turns.length,
                startedAt: conversation.createdAt ? new Date(conversation.createdAt).toISOString() : null,
                durationMs: (conversation.createdAt && conversation.lastActivityAt)
                    ? conversation.lastActivityAt - conversation.createdAt : null,
                redaction: 'conta/perfil mascarados (4 últimos dígitos); texto das mensagens verbatim',
            },
            transcript,
            actions: { commandsUsed: Object.values(usage) },
            outcomes: {
                ordersSent,
                ordersCanceled,
                notFoundTurns,
                erroredTurns,
                abandoned: !!(last && last.is_not_found),
                orders: orders.map(o => ({ type: o.event_type, symbol: o.symbol, side: o.side, quantity: o.quantity, price: o.price, reason: o.reason })),
            },
            capabilities: agentCapabilities(),
            signals: {
                medianLatencyMs: median(turns.map(t => t.total_latency_ms)),
                notFoundRate: turns.length ? +(notFoundTurns / turns.length).toFixed(3) : 0,
                resolvedApprox: !!(last && !last.is_not_found && !last.errored),
            },
            judge: JUDGE_RUBRIC,
            generatedAt: Date.now(),
        }
    }
}

module.exports = { MetricsService }
