// MOCK — stand-in para DbClient (etapa 1)
// initialize é no-op assíncrono; query() sempre resolve com [] (nenhuma linha).
// Não abre conexão real nem acessa disco.

class DbClient {

    async initialize(connection) {
        // no-op: nenhuma conexão real é aberta
        this.connection = connection
        return this
    }

    async query() {
        return []
    }
}

module.exports = { DbClient }
