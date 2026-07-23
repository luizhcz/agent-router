// Cliente Postgres REAL (node-postgres). Expõe a MESMA interface do mock
// src/mock/postgres-client.js — `initialize(conn)` + `query(text, params)` →
// { rows, rowCount } — então os stores (conversation + audit) não mudam ao
// trocar o mock por este. É a implementação usada quando DB_CONVERSATION_CONNECTION
// está no .env.

const { Pool } = require('pg')

class PostgresClient {
    async initialize(connectionString) {
        this.pool = new Pool({ connectionString, max: 10 })
        this.pool.on('error', (e) => console.error('[postgres] pool error:', e.message))
        await this.pool.query('SELECT 1') // valida a conexão no boot (falha alto se o banco não subiu)
        return this
    }

    query(text, params) {
        return this.pool.query(text, params)
    }

    async end() {
        if (this.pool) await this.pool.end()
    }
}

module.exports = { PostgresClient }
