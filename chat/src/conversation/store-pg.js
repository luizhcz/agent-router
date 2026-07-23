// Store DURÁVEL da conversa, sobre um cliente Postgres (interface node-postgres:
// query(text, params)). É a FONTE DA VERDADE — auditável e sobrevive a restart.
// O SQL é real; trocar o PgClient mock por `pg` (new Pool) mantém este arquivo igual.
//
// Colunas alinhadas com a entidade `conversations` das KPIs (docs/design-notes.md,
// Parte 1). Em Postgres real, considerar timestamptz no lugar de BIGINT epoch-ms e
// hash de owner_account (PII). Aqui usamos epoch-ms/valor cru por simplicidade do mock.

const TABLE = 'conversations'

class PgConversationStore {
    constructor(pg) {
        this.pg = pg
    }

    async init() {
        await this.pg.query(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
                id TEXT PRIMARY KEY,
                owner_mode TEXT,
                owner_account TEXT,
                owner_user_profile_id TEXT,
                version TEXT,
                agents JSONB,
                status TEXT,
                created_at BIGINT,
                last_activity_at BIGINT,
                expires_at BIGINT
            )
        `)
    }

    // UPSERT: cria na 1ª vez, atualiza status/atividade nas seguintes.
    async save(record) {
        const o = record.owner || {}
        await this.pg.query(
            `INSERT INTO ${TABLE}
                (id, owner_mode, owner_account, owner_user_profile_id, version, agents, status, created_at, last_activity_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (id) DO UPDATE SET
                status = EXCLUDED.status,
                last_activity_at = EXCLUDED.last_activity_at,
                expires_at = EXCLUDED.expires_at
             RETURNING *`,
            [
                record.id,
                o.mode,
                o.account ?? null,
                o.userProfileId ?? null,
                record.version,
                JSON.stringify(record.agents ?? []),
                record.status,
                record.createdAt,
                record.lastActivityAt,
                record.expiresAt,
            ]
        )
        return record
    }

    async load(id) {
        if (!id) return null
        const res = await this.pg.query(`SELECT * FROM ${TABLE} WHERE id = $1`, [id])
        const row = res.rows && res.rows[0]
        return row ? PgConversationStore._toRecord(row) : null
    }

    async remove(id) {
        await this.pg.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id])
    }

    static _toRecord(row) {
        return {
            id: row.id,
            owner: {
                mode: row.owner_mode,
                account: row.owner_account ?? undefined,
                userProfileId: row.owner_user_profile_id ?? undefined,
            },
            version: row.version,
            // jsonb: pg real devolve objeto; o mock devolve a string que gravamos.
            agents: typeof row.agents === 'string' ? JSON.parse(row.agents) : (row.agents ?? []),
            status: row.status,
            createdAt: Number(row.created_at),
            lastActivityAt: Number(row.last_activity_at),
            expiresAt: Number(row.expires_at),
        }
    }
}

module.exports = { PgConversationStore }
