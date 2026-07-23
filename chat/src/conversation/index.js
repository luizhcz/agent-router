// Conversa como recurso provisionado (versão + agentes + dono). Ver docs/design-notes.md (Parte 2).
const { ConversationStore } = require('./store')
const { ConversationService } = require('./service')
const { HttpError } = require('./errors')

module.exports = { ConversationStore, ConversationService, HttpError }
