// MOCK — stand-in para AwsSecrets (etapa 1)
// loadSecretConfigs é no-op assíncrono: não busca segredos na AWS e não
// sobrescreve o env recebido. Retorna o próprio env para encadeamento.

class AwsSecrets {

    static async loadSecretConfigs(env) {
        // no-op: nenhum segredo real é carregado; env permanece intacto
        return env
    }
}

module.exports = { AwsSecrets }
