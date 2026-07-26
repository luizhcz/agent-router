-- Schema do trader-chat (Postgres). ÚNICA fonte de DDL do projeto — o código da
-- aplicação NÃO executa CREATE TABLE; ele só faz DML (INSERT/SELECT/UPDATE).
--
-- Aplicação:
--   * automática: o docker-compose monta este arquivo em
--     /docker-entrypoint-initdb.d/, então um container Postgres NOVO já sobe com
--     o schema aplicado (`docker compose up -d`).
--   * manual:  psql "$DB_CONVERSATION_CONNECTION" -f schema.sql
--              (ou: docker exec -i trader-chat-postgres psql -U chat -d chat < schema.sql)
--
-- Tipos: tempo em BIGINT epoch-ms (o código grava Date.now()); `agents` em JSONB.
-- Tudo IF NOT EXISTS => idempotente (seguro reaplicar).

-- ============================================================================
-- Registro de conversa (config durável: versão + agentes + dono)
-- ============================================================================
CREATE TABLE IF NOT EXISTS conversations (
    id                    TEXT PRIMARY KEY,
    owner_mode            TEXT,
    owner_account         TEXT,
    owner_user_profile_id TEXT,
    version               TEXT,
    agents                JSONB,
    status                TEXT,
    created_at            BIGINT,
    last_activity_at      BIGINT,
    expires_at            BIGINT
);

CREATE INDEX IF NOT EXISTS idx_conversations_owner_account ON conversations (owner_account);
CREATE INDEX IF NOT EXISTS idx_conversations_status        ON conversations (status);

-- ============================================================================
-- Auditoria / KPIs (append-only, 1 turno = 1 mensagem do usuário)
-- ============================================================================
CREATE TABLE IF NOT EXISTS turns (
    id               TEXT PRIMARY KEY,
    conversation_id  TEXT REFERENCES conversations (id) ON DELETE SET NULL,
    context_id       TEXT,
    seq              BIGINT,
    user_text        TEXT,
    agent_text       TEXT,
    state            TEXT,
    next_state       TEXT,
    interrupt        BOOLEAN,
    interrupt_type   TEXT,
    had_output_card  BOOLEAN,
    output_card_type TEXT,
    is_not_found     BOOLEAN,
    errored          BOOLEAN,
    total_latency_ms DOUBLE PRECISION,
    created_at       BIGINT
);

CREATE INDEX IF NOT EXISTS idx_turns_conversation_id ON turns (conversation_id);
CREATE INDEX IF NOT EXISTS idx_turns_created_at      ON turns (created_at);

CREATE TABLE IF NOT EXISTS command_executions (
    id               TEXT PRIMARY KEY,
    turn_id          TEXT REFERENCES turns (id) ON DELETE CASCADE,
    seq              BIGINT,
    command_method   TEXT,
    agent            TEXT,
    result_status    TEXT,
    output_card_type TEXT,
    created_at       BIGINT
);

CREATE INDEX IF NOT EXISTS idx_command_executions_turn_id ON command_executions (turn_id);
CREATE INDEX IF NOT EXISTS idx_command_executions_method  ON command_executions (command_method);

CREATE TABLE IF NOT EXISTS llm_calls (
    id            TEXT PRIMARY KEY,
    turn_id       TEXT REFERENCES turns (id) ON DELETE CASCADE,
    mode          TEXT,
    model         TEXT,
    input_tokens  BIGINT,
    output_tokens BIGINT,
    latency_ms    DOUBLE PRECISION,
    parse_ok      BOOLEAN,
    created_at    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_llm_calls_turn_id ON llm_calls (turn_id);

-- ============================================================================
-- Eventos de ORDEM (EXTERNOS: ORDER_SENT / ORDER_CANCELED). Fonte da verdade
-- dos KPIs de execução — quantas ordens foram enviadas/canceladas e o MOTIVO do
-- cancelamento. Chegam pelo backend de ordens via POST /api/trader-chat/event,
-- fora do fluxo de conversa (não é um turno). `conversation_id` liga a ordem à
-- conversa que a originou, quando conhecido.
-- ============================================================================
CREATE TABLE IF NOT EXISTS order_events (
    id              TEXT PRIMARY KEY,
    event_type      TEXT,               -- ORDER_SENT | ORDER_CANCELED
    account         TEXT,
    order_id        TEXT,
    symbol          TEXT,
    side            TEXT,               -- BUY | SELL
    quantity        DOUBLE PRECISION,
    price           DOUBLE PRECISION,
    reason          TEXT,               -- motivo (preenchido só em ORDER_CANCELED)
    conversation_id TEXT REFERENCES conversations (id) ON DELETE SET NULL,
    context_id      TEXT,
    created_at      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_order_events_account    ON order_events (account);
CREATE INDEX IF NOT EXISTS idx_order_events_type       ON order_events (event_type);
CREATE INDEX IF NOT EXISTS idx_order_events_created_at ON order_events (created_at);

-- ============================================================================
-- Preço por modelo de LLM (tabela de referência p/ métricas de CUSTO). model_id
-- casa com llm_calls.model; o custo de cada chamada = input_tokens*price_per_input
-- + output_tokens*price_per_output, respeitando a vigência (effective_from/to).
-- Preços em `currency` por TOKEN. Tempo em BIGINT epoch-ms. (nomes de coluna em
-- snake_case, seguindo o resto do schema: ModelId->model_id, etc.)
-- ============================================================================
CREATE TABLE IF NOT EXISTS model_pricing (
    id                     TEXT PRIMARY KEY,
    model_id               TEXT NOT NULL,          -- casa com llm_calls.model
    provider               TEXT,
    price_per_input_token  NUMERIC,                -- preço por token de ENTRADA (em `currency`)
    price_per_output_token NUMERIC,                -- preço por token de SAÍDA
    currency               TEXT,
    effective_from         BIGINT,                 -- vigência inicial (epoch-ms)
    effective_to           BIGINT,                 -- vigência final; NULL = vigente
    created_at             BIGINT,
    UNIQUE (model_id, effective_from)
);

CREATE INDEX IF NOT EXISTS idx_model_pricing_model ON model_pricing (model_id);

-- Seed de preços (idempotente via ON CONFLICT). USD por token.
INSERT INTO model_pricing (id, model_id, provider, price_per_input_token, price_per_output_token, currency, effective_from, effective_to, created_at) VALUES
    ('mp_gpt54mini_v1', 'gpt-5.4-mini', 'openai', 0.00000015, 0.00000060, 'USD', 1704067200000, NULL, 1704067200000),
    ('mp_gpt54_v1',     'gpt-5.4',      'openai', 0.00000250, 0.00001000, 'USD', 1704067200000, NULL, 1704067200000)
ON CONFLICT (model_id, effective_from) DO NOTHING;
