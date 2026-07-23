// MOCK — simula um Postgres com a interface do node-postgres: `query(text, params)`
// devolvendo `{ rows, rowCount }`. Reconhece o subconjunto de SQL que o store de
// conversa emite (CREATE TABLE / INSERT ... ON CONFLICT ... RETURNING / SELECT WHERE
// id / DELETE WHERE id) sobre tabelas em memória.
//
// O ponto: o SQL é REAL. Trocar este mock por `pg` (new Pool({connectionString}))
// mantém o store idêntico — só o cliente muda. `PG_MOCK_LOG=1` loga cada query.

class PgClient {
    constructor() {
        this.tables = new Map() // nome -> { pk, rows: Map<pkVal, row> }
        this.queryLog = []
        this._log = !!process.env.PG_MOCK_LOG
    }

    async initialize(conn) {
        this.conn = conn
        return this
    }

    async connect() {
        return this
    }

    async end() {}

    async query(text, params = []) {
        const flat = text.replace(/\s+/g, ' ').trim()
        this.queryLog.push({ text: flat, params })
        if (this._log) console.log('[pg-mock]', flat, params.length ? JSON.stringify(params) : '')

        const sql = text.trim()

        // CREATE TABLE [IF NOT EXISTS] <name> ( ... <col> ... PRIMARY KEY ... )
        let m = sql.match(/^create table(?:\s+if not exists)?\s+(\w+)\s*\(([\s\S]+)\)\s*;?$/i)
        if (m) {
            const name = m[1]
            if (!this.tables.has(name)) {
                const pk = (m[2].match(/(\w+)\s+[^,]*primary key/i) || [, 'id'])[1]
                this.tables.set(name, { pk, rows: new Map() })
            }
            return { rows: [], rowCount: 0 }
        }

        // INSERT INTO <name> (cols) VALUES ($1,...) [ON CONFLICT ...] [RETURNING *]
        m = sql.match(/^insert into\s+(\w+)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)([\s\S]*)$/i)
        if (m) {
            const table = this._table(m[1])
            const cols = m[2].split(',').map(s => s.trim())
            const placeholders = m[3].split(',').map(s => s.trim())
            const row = {}
            cols.forEach((c, i) => { row[c] = this._resolve(placeholders[i], params) })
            // ON CONFLICT (pk) DO UPDATE = overwrite (o store sempre passa a linha completa).
            table.rows.set(row[table.pk], row)
            const returning = /returning\s+\*/i.test(m[4])
            return { rows: returning ? [{ ...row }] : [], rowCount: 1 }
        }

        // SELECT * FROM <name> WHERE <col> = $n
        m = sql.match(/^select\s+\*\s+from\s+(\w+)\s+where\s+(\w+)\s*=\s*\$(\d+)\s*;?$/i)
        if (m) {
            const table = this._table(m[1])
            const val = params[Number(m[3]) - 1]
            const rows = [...table.rows.values()].filter(r => r[m[2]] === val).map(r => ({ ...r }))
            return { rows, rowCount: rows.length }
        }

        // SELECT * FROM <name>  (sem where — inspeção)
        m = sql.match(/^select\s+\*\s+from\s+(\w+)\s*;?$/i)
        if (m) {
            const rows = [...this._table(m[1]).rows.values()].map(r => ({ ...r }))
            return { rows, rowCount: rows.length }
        }

        // DELETE FROM <name> WHERE <col> = $n
        m = sql.match(/^delete\s+from\s+(\w+)\s+where\s+(\w+)\s*=\s*\$(\d+)\s*;?$/i)
        if (m) {
            const table = this._table(m[1])
            const val = params[Number(m[3]) - 1]
            let n = 0
            for (const [k, r] of table.rows) if (r[m[2]] === val) { table.rows.delete(k); n++ }
            return { rows: [], rowCount: n }
        }

        throw new Error('[pg-mock] SQL não suportada: ' + flat.slice(0, 100))
    }

    _table(name) {
        if (!this.tables.has(name)) this.tables.set(name, { pk: 'id', rows: new Map() })
        return this.tables.get(name)
    }

    _resolve(token, params) {
        const m = token.match(/^\$(\d+)$/)
        if (m) return params[Number(m[1]) - 1]
        if (/^'.*'$/.test(token)) return token.slice(1, -1)
        if (token.toLowerCase() === 'null') return null
        return token
    }
}

module.exports = { PgClient }
