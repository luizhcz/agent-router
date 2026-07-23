const { AgentRuntime } = require('../agent-runtime')
const { BaseAgent } = require('./base-agent')
const { TraderAgent } = require('./trader-agent')
const { ContentAgent } = require('./content-agent')

class TraderChatAgent extends ContentAgent {}   // instância única: base+trader+content

// fontes de comando para o runtime taguear por agente (reflexão por classe):
TraderChatAgent.commandSources = [
    { agent: 'trader', class: TraderAgent },
    { agent: 'content', class: ContentAgent },
]

AgentRuntime.agentClasses['trader-agent'] = TraderChatAgent

module.exports = { BaseAgent, TraderAgent, ContentAgent, TraderChatAgent }
