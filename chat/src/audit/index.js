// Log de auditoria/KPIs (append-only). Ver docs/design-notes.md (Parte 1).
const { AuditLog } = require('./audit-log')
const { initSchema, TABLE_NAMES } = require('./schema')

module.exports = { AuditLog, initSchema, TABLE_NAMES }
