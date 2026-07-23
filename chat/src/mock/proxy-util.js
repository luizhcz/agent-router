// MOCK — stand-in para ProxyUtil (etapa 1)
// initialize é no-op síncrono: não configura nenhum agente de proxy HTTP.

class ProxyUtil {

    static initialize() {
        // no-op síncrono
    }
}

module.exports = { ProxyUtil }
