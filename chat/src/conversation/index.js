// Conversa como recurso provisionado (versão + agentes + dono). Ver docs/design-notes.md (Parte 2).
// Persistência write-through: Postgres (durável) + Redis (cache quente).
const { WriteThroughStore } = require('./store')
const { PgConversationStore } = require('./store-pg')
const { RedisConversationStore } = require('./store-redis')
const { ConversationService } = require('./service')
const { HttpError } = require('./errors')

module.exports = {
    WriteThroughStore,
    PgConversationStore,
    RedisConversationStore,
    ConversationService,
    HttpError,
}
