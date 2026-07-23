// Log de auditoria/KPIs (append-only). Ver docs/design-notes.md (Parte 1).
// O DDL das tabelas vive em chat/schema.sql — a aplicação não executa DDL.
const { AuditLog } = require('./audit-log')

module.exports = { AuditLog }
