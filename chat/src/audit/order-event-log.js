// Log de eventos de ORDEM (append-only). Recebe os eventos EXTERNOS de execução
// (ORDER_SENT / ORDER_CANCELED) vindos do backend de ordens e grava em `order_events`
// — a fonte da verdade dos KPIs de execução (quantas ordens enviadas/canceladas e o
// MOTIVO do cancelamento). Reusa o mesmo cliente Postgres do audit. É BEST-EFFORT:
// nunca lança; o endpoint responde ok mesmo se o INSERT falhar (o evento externo não
// pode ser perdido por um erro transitório de banco — em produção, considere retry/fila).

const crypto = require('crypto')

class OrderEventLog {
    constructor(pg) {
        this.pg = pg
    }

    // DDL não vive aqui — a tabela `order_events` é criada por chat/schema.sql.

    /**
     * Grava 1 evento de ordem. `e` é o payload já normalizado pelo handler.
     * `reason` só faz sentido em ORDER_CANCELED. Devolve o id gravado, ou null em erro.
     */
    async record(e) {
        try {
            const id = crypto.randomUUID()
            await this.pg.query(
                `INSERT INTO order_events
                    (id, event_type, account, order_id, symbol, side, quantity, price, reason, conversation_id, context_id, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    id,
                    e.eventType ?? null,
                    e.account ?? null,
                    e.orderId ?? null,
                    e.symbol ?? null,
                    e.side ?? null,
                    e.quantity ?? null,
                    e.price ?? null,
                    e.reason ?? null,
                    e.conversationId ?? null,
                    e.contextId ?? null,
                    e.timestamp ?? Date.now(),
                ]
            )
            return id
        } catch (err) {
            console.error('[OrderEventLog] falha ao gravar evento (ignorada):', err && err.message)
            return null
        }
    }
}

module.exports = { OrderEventLog }
