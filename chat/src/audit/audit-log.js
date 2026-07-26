// Log de auditoria/KPIs: grava, por turno, as tabelas turns / command_executions /
// llm_calls (append-only) via um cliente Postgres. É BEST-EFFORT — nunca lança para
// dentro do fluxo do chat (auditoria não pode quebrar a conversa); em produção,
// considere fila/batch para não somar latência ao turno, e torná-lo obrigatório se
// compliance exigir. (Sem router no chat de agente único: nada de routing_* aqui.)

const crypto = require('crypto')

class AuditLog {
    constructor(pg) {
        this.pg = pg
    }

    // DDL não vive aqui — as tabelas são criadas por chat/schema.sql (fora da aplicação).

    /**
     * Grava um turno completo. `t` é o payload cru montado pelo runtime; a
     * derivação (status, rank do comando no router, was_executed) mora aqui.
     * Nunca lança.
     */
    async recordTurn(t) {
        try {
            const now = Date.now()
            const turnId = crypto.randomUUID()
            const results = flattenResults(t.results)
            const isNotFound = results.some(r => r && r.type === 'notFound')

            await this._insert('turns', {
                id: turnId,
                conversation_id: t.conversationId ?? null,
                context_id: t.contextId ?? null,
                seq: t.seq ?? null,
                user_text: t.userText ?? null, // redigir em produção (PII)
                agent_text: t.agentText ?? null,
                state: t.state ?? null,
                next_state: t.nextState ?? null,
                interrupt: !!t.interrupt,
                interrupt_type: t.interrupt ? (t.interrupt.state || t.interrupt.type || null) : null,
                had_output_card: !!t.outputCardType,
                output_card_type: t.outputCardType ?? null,
                is_not_found: isNotFound,
                errored: !!t.errored,
                total_latency_ms: t.totalLatencyMs ?? null,
                created_at: now,
            })

            let seq = 0
            for (const r of results) {
                if (!r || !r.type) continue
                const method = r.type
                await this._insert('command_executions', {
                    id: crypto.randomUUID(),
                    turn_id: turnId,
                    seq: seq++,
                    command_method: method,
                    agent: (t.commandAgentByMethod && t.commandAgentByMethod.get(method)) || 'system',
                    result_status: statusOf(r),
                    output_card_type: null,
                    created_at: now,
                })
            }

            for (const call of (t.llmCalls || [])) {
                await this._insert('llm_calls', {
                    id: crypto.randomUUID(),
                    turn_id: turnId,
                    mode: call.mode,
                    model: call.model ?? null,
                    input_tokens: call.inputTokens ?? null, // preenche quando o LLM real reportar usage
                    output_tokens: call.outputTokens ?? null,
                    latency_ms: call.latencyMs ?? null,
                    parse_ok: call.parseOk ?? null,
                    created_at: now,
                })
            }

            return turnId
        } catch (e) {
            console.error('[AuditLog] falha ao gravar turno (ignorada):', e && e.message)
            return null
        }
    }

    async _insert(table, obj) {
        const cols = Object.keys(obj)
        const params = cols.map(c => obj[c])
        const placeholders = cols.map((_, i) => '$' + (i + 1))
        await this.pg.query(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
            params
        )
    }
}

function flattenResults(results) {
    if (!Array.isArray(results)) return []
    const out = []
    for (const group of results) {
        if (Array.isArray(group)) out.push(...group)
        else if (group) out.push(group)
    }
    return out
}

function statusOf(r) {
    if (r.type === 'notFound') return 'not_found'
    if (r.data !== undefined) return 'success'
    if (r.instruction !== undefined) return 'instruction'
    return 'ok'
}

module.exports = { AuditLog }
