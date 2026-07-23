const { EnvUtils, Utils, DateUtils } = require("./utils")
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

class AgentRuntime {

    static agentClasses = {}

    async initialize(AgentClass) {

        if (typeof AgentClass == 'string') {
            AgentClass = AgentRuntime.agentClasses[AgentClass]
            if (!AgentClass) {
                throw new Error('AgentClass Not Defined')
            }
        }

        this.AgentClass = AgentClass
        this.llmService = EnvUtils.getInstance('llmService')
        this.contexts = {}

        await this.initializePromptElements(AgentClass)
    }

    async getContext(contextId, createIfNull = false) {

        if (!contextId) {
            return
        }

        let context = this.contexts[contextId]
        if (!context) {
            if (!createIfNull) {
                return undefined
            }

            const agent = new this.AgentClass()
            agent.runtime = this

            context = {
                contextId,
                state: 'default',
                commandInterrupt: undefined,
                pendingCommands: undefined,
                messages: [],
                messagesSignal: Utils.signal(true),
                agent
            }

            this.contexts[contextId] = context

            agent.context = context
            await agent.initialize()
        }

        return context
    }

    async reset(context, sendMessage = false) {

        if (typeof context != 'object') {
            context = this.contexts[context]
        }

        if (!context) {
            return
        }

        context.state = 'default'
        context.commandInterrupt = undefined
        context.pendingCommands = undefined
        context.messages = []

        await context.agent?.reset?.()

        setTimeout(() => {

            if (sendMessage) {
                let res = { role: 'system', content: 'reset', reset: true }
                context.messagesSignal.set(res)
            } else {
                context.messagesSignal.set()
            }

        }, 1500)
    }

    async initializePromptElements(AgentClass) {

        // commands montados 1x por reflexão (runtime primeiro), cada um tagueado com seu agente
        const sourceCommands = AgentClass.commandSources
            ? AgentClass.commandSources.flatMap(source =>
                AgentRuntime.getAgentPromptElements(source.class, source.agent).commands)
            : AgentRuntime.getAgentPromptElements(AgentClass, null).commands

        this.commandElements = [
            ...AgentRuntime.getAgentPromptElements(AgentRuntime, 'system').commands,
            ...sourceCommands,
        ]

        // índice dos arquivos de prompt versionados em src/prompts/
        this._promptsDir = path.join(__dirname, 'prompts')

        let promptFiles = []
        try {
            promptFiles = fs.readdirSync(this._promptsDir)
        } catch {
            promptFiles = []
        }

        this._promptVersions = promptFiles
            .map(f => (f.match(/^prompt\.(.+)\.yml$/) || [])[1])
            .filter(v => v && Utils.isValidVersion(v))
            .sort((a, b) => Utils.compareVersions(a, b))

        if (!this._promptVersions.length) {
            throw new Error(`Nenhum prompt.<versao>.yml encontrado em ${this._promptsDir}`)
        }

        this._promptCache = {}
    }

    _resolvePromptVersion(chatVersion) {
        const versions = this._promptVersions
        if (!versions?.length) {
            throw new Error('Nenhum prompt.<versao>.yml disponível')
        }
        if (!chatVersion) return versions[versions.length - 1]  // sem versão => latest
        let resolved = null
        for (const v of versions) {
            if (Utils.compareVersions(v, chatVersion) <= 0) resolved = v  // maior <= chatVersion (lista asc)
        }
        return resolved ?? versions[0]  // nenhum <= => menor disponível
    }

    resolvePromptElements(chatVersion) {
        const version = this._resolvePromptVersion(chatVersion)
        if (this._promptCache[version]) return this._promptCache[version]

        const file = path.join(this._promptsDir, `prompt.${version}.yml`)
        const doc = yaml.load(fs.readFileSync(file, 'utf8')) ?? {}

        const section = (key, tag) => AgentRuntime.extractSection('# ' + tag + '\n' + (doc[key] ?? ''), tag)

        // outputIn: extrai e aplica a normalização migrada de initializePromptElements
        let outputIn = AgentRuntime.extractOutputIn('# OUTPUT_IN\n' + (doc.outputIn ?? ''))
        if (outputIn?.length) {
            const raw = outputIn.join('\n')
            const match = raw.match(/```json\s*([\s\S]*?)\s*```/)
            if (match) outputIn = 'JSON\n' + match[1]
        }

        const elements = {
            profile: section('profile', 'PROFILE'),
            capabilities: section('capabilities', 'CAPABILITIES'),
            memoryContext: section('memoryContext', 'MEMORY_CONTEXT'),
            goalIn: section('goalIn', 'GOAL_IN'),
            goalOut: section('goalOut', 'GOAL_OUT'),
            rulesIn: section('rulesIn', 'RULES_IN'),
            restrictionsIn: section('restrictionsIn', 'RESTRICTIONS_IN'),
            rulesOut: section('rulesOut', 'RULES_OUT'),
            restrictionsOut: section('restrictionsOut', 'RESTRICTIONS_OUT'),
            outputIn,
            commands: this.commandElements,
        }

        this._promptCache[version] = elements
        return elements
    }

    static cleanLine(l) {
        return l
            .replace(/^\s*\*?\s?-?\s?/, '')
            .trim()
    }

    static extractSection(block, tag) {
        const pattern = new RegExp(`#\\s*${tag}(?:\\s+\\[([^\\]]+)\\])?\\s*\\n([\\s\\S]*?)(?=\\n\\s*#|$)`)
        const match = block.match(pattern)
        if (!match) return []
        const sectionFlag = match[1] ?? null
        return match[2]
            .split('\n')
            .map(l => {
                const cleaned = AgentRuntime.cleanLine(l)
                if (!cleaned || cleaned.startsWith('#')) return null
                // linha condicional: [flag] texto
                const lineFlag = cleaned.match(/^\[(\!?[\w]+)\]\s+(.+)$/)
                if (lineFlag) return { text: lineFlag[2], flag: lineFlag[1], sectionFlag }
                return { text: cleaned, flag: null, sectionFlag }
            })
            .filter(Boolean)
    }

    static extractOutputIn(block) {
        const pattern = /#\s*OUTPUT_IN[^\n]*\n([\s\S]*?)(?=\n\s*#|$)/
        const match = block.match(pattern)
        if (!match) return []
        return match[1]
            .split('\n')
            .map(l => l.replace(/^\s*\*\s?/, ''))
            .join('\n')
            .trim()
            .split('\n')
    }

    static getAgentPromptElements(TargetClass, agentName = null) {

        const source = TargetClass.toString()

        const promptElements = {
            goalIn: [],
            goalOut: [],
            outputIn: [],
            profile: [],
            capabilities: [],
            memoryContext: [],
            rulesIn: [],
            restrictionsIn: [],
            rulesOut: [],
            restrictionsOut: [],
            commands: []
        }

        const blockMatches = [...source.matchAll(/\/\*([\s\S]*?)\*\//g)]
        const blocks = blockMatches.map(m => ({ content: m[1], end: m.index + m[0].length }))

        const cleanDesc = (str) => str
            .replace(/\s*->\s*/g, ' -> ')
            .replace(/\s*:\s*/g, ': ')
            .replace(/\s{2,}/g, ' ')
            .trim()

        const extractMethodSignature = (blockEnd) => {
            const after = source.slice(blockEnd)
            const match = after.match(/^\s*(?:async\s+)?(\w+)\s*\(([^)]*)\)/)
            if (!match) return null
            const method = match[1]
            const argsRaw = match[2].trim()
            if (!argsRaw) return { method, paramNames: [] }

            // extrai conteúdo entre primeiro { e seu } correspondente, ignorando default value ( = {} )
            const destructMatch = argsRaw.match(/^\{([^}]*)\}/)
            const inner = destructMatch ? destructMatch[1].trim() : argsRaw

            const paramNames = inner.split(',')
                .map(p => p.trim())
                .filter(p => p && p !== 'type')
                .filter(Boolean)
            return { method, paramNames }
        }

        const extractInputDescs = (block) => {
            const descs = {}
            for (const m of block.matchAll(/@input\s+(\w+)\s*[:\-]\s*([^\n*@]+)/g))
                descs[m[1].trim()] = cleanDesc(m[2])
            return descs
        }

        const extractOutputDescs = (block) => {
            const outputs = []
            for (const m of block.matchAll(/@output\s+(\w+)\s*:\s*([^\n*@]+)/g))
                outputs.push({ name: m[1].trim(), desc: cleanDesc(m[2]) })
            return outputs
        }

        const extractNotes = (block) => {
            const notes = []

            // texto livre -> desc principal (note 'in', state null)
            const descLines = block
                .split('\n')
                .map(AgentRuntime.cleanLine)
                .filter(l => l && !l.startsWith('#') && !l.startsWith('@'))

            if (descLines.length > 0)
                notes.push({ state: null, context: 'in', text: descLines.join(' ') })

            // @note[tags] text
            for (const m of block.matchAll(/@note(?:\[([^\]]*)\])?\s+(.+)/g)) {
                const rawTags = m[1]?.split(',').map(t => t.trim()) ?? []
                const text = m[2].trim()
                const context = rawTags.some(t => t.toLowerCase() === 'out') ? 'out' : 'in'
                const state = rawTags.find(t => t.toLowerCase() !== 'out') ?? null
                notes.push({ state, context, text })
            }

            return notes
        }

        const extractExamples = (block) => {
            const examples = []
            for (const m of block.matchAll(/@example(?:\[(\w+)\])?\s+(.+)/g)) {
                const state = m[1]?.trim() ?? null
                const text = m[2].trim()
                if (state) examples.push({ state, text })
                else examples.push(text)
            }
            return examples
        }

        blocks.forEach(({ content: block, end }) => {

            if (block.includes('# GOAL_IN')) promptElements.goalIn = AgentRuntime.extractSection(block, 'GOAL_IN')
            if (block.includes('# GOAL_OUT')) promptElements.goalOut = AgentRuntime.extractSection(block, 'GOAL_OUT')
            if (block.includes('# OUTPUT_IN')) promptElements.outputIn = AgentRuntime.extractOutputIn(block)
            if (block.includes('# PROFILE')) promptElements.profile = AgentRuntime.extractSection(block, 'PROFILE')
            if (block.includes('# CAPABILITIES')) promptElements.capabilities = AgentRuntime.extractSection(block, 'CAPABILITIES')
            if (block.includes('# MEMORY_CONTEXT')) promptElements.memoryContext = AgentRuntime.extractSection(block, 'MEMORY_CONTEXT')
            if (block.includes('# RULES_IN')) promptElements.rulesIn = AgentRuntime.extractSection(block, 'RULES_IN')
            if (block.includes('# RESTRICTIONS_IN')) promptElements.restrictionsIn = AgentRuntime.extractSection(block, 'RESTRICTIONS_IN')
            if (block.includes('# RULES_OUT')) promptElements.rulesOut = AgentRuntime.extractSection(block, 'RULES_OUT')
            if (block.includes('# RESTRICTIONS_OUT')) promptElements.restrictionsOut = AgentRuntime.extractSection(block, 'RESTRICTIONS_OUT')

            if (/^\s*#\s*COMMAND(?!S)\b/m.test(block)) {
                const signature = extractMethodSignature(end)
                if (!signature) return

                const { method, paramNames } = signature

                // flag do bloco: # COMMAND [flag]
                const cmdFlagMatch = block.match(/#\s*COMMAND\s+\[(\!?[\w]+)\]/)
                const commandFlag = cmdFlagMatch ? cmdFlagMatch[1] : null

                const inputDescs = extractInputDescs(block)
                const outputs = extractOutputDescs(block)
                const notes = extractNotes(block)
                const examples = extractExamples(block)

                const inputs = paramNames.map(name => ({
                    name,
                    desc: cleanDesc(inputDescs[name] ?? '')
                }))

                promptElements.commands.push({ method, inputs, outputs, notes, examples, flag: commandFlag, agent: agentName })
            }
        })

        return promptElements
    }

    getPromptChatInput(context) {
        const msg = context.messages[context.messages.length - 1]
        const chatInput = `[${msg.role}] ${msg.content}`
        return chatInput
    }

    getPromptChatHistory(context) {
        const chatHistory = context.messages.slice(-6, -1).map(m => `[${m.role}] ${m.content}`).join('\n\n') || '(null)'
        return chatHistory
    }

    getPromptMemoryContext(context, memoryContextKeys, flags) {

        let promptMemoryContext = [
            `- currentDate: ${DateUtils.toLocalISOString(new Date()).substring(0, 10)}`,
            `- currentTime: ${DateUtils.toLocalISOString(new Date()).substring(11, 19)} (local)`,
            `- state: ${context.state}`,
            `- commandInterrupt: ${context.commandInterrupt ? JSON.stringify(context.commandInterrupt) : '(null)'}`
        ]

        if (memoryContextKeys?.length > 0) {
            const filtered = flags
                ? memoryContextKeys.filter(item => {
                    if (typeof item === 'string') return true
                    if (item.sectionFlag && !AgentRuntime._evalFlag(item.sectionFlag, flags)) return false
                    if (item.flag && !AgentRuntime._evalFlag(item.flag, flags)) return false
                    return true
                })
                : memoryContextKeys

            for (const item of filtered) {
                const key = typeof item === 'string' ? item : item.text
                promptMemoryContext.push(`- ${key}: ${context.agent[key] ?? '(null)'}`)
            }
        }

        return promptMemoryContext.join('\n')
    }

    static _evalFlag(flagExpr, agent) {
        if (!flagExpr || !agent) return true
        if (agent.context?.state == flagExpr) return true
        const negate = flagExpr.startsWith('!')
        const key = negate ? flagExpr.slice(1) : flagExpr
        return negate ? !agent[key] : !!agent[key]
    }

    static _filterElements(items, agent) {
        if (!items?.length || !agent) return items?.map?.(i => typeof i === 'string' ? i : i.text) ?? items
        return items
            .filter(item => {
                if (typeof item === 'string') return true
                if (item.sectionFlag && !AgentRuntime._evalFlag(item.sectionFlag, agent)) return false
                if (item.flag && !AgentRuntime._evalFlag(item.flag, agent)) return false
                return true
            })
            .map(item => typeof item === 'string' ? item : item.text)
    }

    // getPromptPre(context) {

    //     const chatHistory = this.getPromptChatHistory(context)
    //     const chatInput = this.getPromptChatInput(context)

    //     let { profile, capabilities, commands, memoryContext } = this.promptElements

    //     memoryContext = this.getPromptMemoryContext(context, memoryContext)

    //     let prompt = []

    //     prompt.push('# GOAL')
    //     prompt.push([
    //         '- Analisar [CHAT_INPUT] com suporte de [CHAT_HISTORY] e identificar quais comandos de [COMMANDS] são candidatos para atender a intenção do usuário.',
    //         '- Considerar [MEMORY_CONTEXT] para evitar selecionar comandos cujos dados já estão em memória e não precisam ser reemitidos.',
    //         '- Retornar apenas os nomes dos comandos candidatos — sem parâmetros, sem execução.',
    //     ].join('\n'))

    //     if (profile?.length) {
    //         prompt.push('# PROFILE')
    //         prompt.push(profile.map(o => `- ${o}`).join('\n'))
    //     }

    //     if (capabilities?.length) {
    //         prompt.push('# CAPABILITIES')
    //         prompt.push(capabilities.map(o => `- ${o}`).join('\n'))
    //     }

    //     if (commands?.length > 0) {
    //         prompt.push('# COMMANDS')
    //         prompt.push(commands.map(c => {
    //             const desc = c.notes?.find(n => n.context === 'in' && n.state === null)?.text ?? ''
    //             return `[${c.method}]${desc ? ' -> ' + desc : ''}`
    //         }).join('\n'))
    //     }

    //     if (memoryContext) {
    //         prompt.push('# MEMORY_CONTEXT')
    //         prompt.push(memoryContext)
    //     }

    //     if (chatHistory) {
    //         prompt.push('# CHAT_HISTORY')
    //         prompt.push(chatHistory)
    //     }

    //     if (chatInput) {
    //         prompt.push('# CHAT_INPUT')
    //         prompt.push(chatInput)
    //     }

    //     prompt.push('# OUTPUT (JSON)')
    //     prompt.push('["commandName", ...]')

    //     return prompt.join('\n\n')
    // }

    getPromptIn(context, filterCommands) {

        const agent = context.agent

        const chatHistory = this.getPromptChatHistory(context)
        const chatInput = this.getPromptChatInput(context)

        let { profile, goalIn, capabilities, rulesIn, restrictionsIn, commands, memoryContext, outputIn } = this.resolvePromptElements(context.agent?.chatVersion)

        profile = AgentRuntime._filterElements(profile, agent)
        goalIn = AgentRuntime._filterElements(goalIn, agent)
        capabilities = AgentRuntime._filterElements(capabilities, agent)
        rulesIn = AgentRuntime._filterElements(rulesIn, agent)
        restrictionsIn = AgentRuntime._filterElements(restrictionsIn, agent)

        memoryContext = this.getPromptMemoryContext(context, memoryContext, agent)

        if (commands) {
            commands = commands.filter(c =>
                AgentRuntime._evalFlag(c.flag, agent) &&
                (agent.isCommandAvailable?.(c.method) ?? true)
            )
        }
        if (commands && filterCommands) {
            commands = commands.filter(c => filterCommands[c.method])
        }

        let prompt = []

        if (profile) {
            prompt.push('# PROFILE')
            prompt.push(profile.map(o => `- ${o}`).join('\n'))
        }

        if (goalIn) {
            prompt.push('# GOAL')
            prompt.push(goalIn.map(o => `- ${o}`).join('\n'))
        }

        if (capabilities) {
            prompt.push('# CAPABILITIES')
            prompt.push(capabilities.map(o => `- ${o}`).join('\n'))
        }

        if (rulesIn) {
            prompt.push('# RULES')
            prompt.push(rulesIn.map(o => `- ${o}`).join('\n'))
        }

        if (restrictionsIn) {
            prompt.push('# RESTRICTIONS')
            prompt.push(restrictionsIn.map(o => `- ${o}`).join('\n'))
        }

        if (commands?.length > 0) {
            const state = context.state ?? 'default'
            prompt.push('# COMMANDS')
            prompt.push(commands.map(c => {
                const lines = []

                // desc: primeira note 'in', state null
                const desc = c.notes?.find(n => n.context === 'in' && n.state === null)?.text ?? ''

                // extra: demais notes state null (slice(1)) + state-specific do estado atual
                const extra = [
                    ...(c.notes?.filter(n => n.context === 'in' && n.state === null).slice(1) ?? []),
                    ...(c.notes?.filter(n => n.context === 'in' && n.state !== null && n.state === state) ?? [])
                ]

                lines.push(`[${c.method}]${desc ? ' -> ' + desc : ''}`)

                if (extra.length) {
                    lines.push('  notes:')
                    for (const n of extra) lines.push(`    - ${n.text}`)
                }

                if (c.inputs?.length) {
                    lines.push('  input:')
                    for (const i of c.inputs) lines.push(`    - ${i.name}${i.desc ? ': ' + i.desc : ''}`)
                }

                if (c.outputs?.length) {
                    lines.push('  output:')
                    for (const o of c.outputs) lines.push(`    - ${o.name}: ${o.desc}`)
                }

                if (c.examples?.length) {
                    const generalExamples = c.examples.filter(e => typeof e === 'string')
                    const stateExamples = c.examples.filter(e => typeof e === 'object' && e.state === state).map(e => e.text)
                    const visibleExamples = [...generalExamples, ...stateExamples]

                    if (visibleExamples.length) {
                        lines.push('  example:')
                        for (const e of visibleExamples) lines.push(`    - ${e}`)
                    }
                }

                return lines.join('\n')
            }).join('\n\n'))
        }

        if (memoryContext) {
            prompt.push('# MEMORY_CONTEXT')
            prompt.push(memoryContext)
        }

        if (chatHistory) {
            prompt.push('# CHAT_HISTORY')
            prompt.push(chatHistory)
        }

        if (chatInput) {
            prompt.push('# CHAT_INPUT')
            prompt.push(chatInput)
        }

        if (outputIn) {
            if (outputIn.startsWith('JSON\n')) {
                prompt.push('# OUTPUT (JSON)')
                prompt.push(outputIn.replace(/^JSON\n/, ''))
            } else {
                prompt.push('# OUTPUT')
                prompt.push(outputIn)
            }
        }

        return prompt.join('\n\n')
    }

    getPromptOut(context, data, filterCommands) {

        const agent = context.agent

        const chatHistory = this.getPromptChatHistory(context)
        const chatInput = this.getPromptChatInput(context)

        let { profile, goalOut, capabilities, rulesOut, restrictionsOut, commands, memoryContext } = this.resolvePromptElements(context.agent?.chatVersion)

        profile = AgentRuntime._filterElements(profile, agent)
        goalOut = AgentRuntime._filterElements(goalOut, agent)
        capabilities = AgentRuntime._filterElements(capabilities, agent)
        rulesOut = AgentRuntime._filterElements(rulesOut, agent)
        restrictionsOut = AgentRuntime._filterElements(restrictionsOut, agent)

        memoryContext = this.getPromptMemoryContext(context, memoryContext, agent)

        if (commands) {
            commands = commands.filter(c =>
                AgentRuntime._evalFlag(c.flag, agent) &&
                (agent.isCommandAvailable?.(c.method) ?? true)
            )
        }
        if (commands && filterCommands) {
            commands = commands.filter(c => filterCommands.includes(c.method))
        }

        let prompt = []

        if (profile) {
            prompt.push('# PROFILE')
            prompt.push(profile.map(o => `- ${o}`).join('\n'))
        }

        if (goalOut) {
            prompt.push('# GOAL')
            prompt.push(goalOut.map(o => `- ${o}`).join('\n'))
        }

        if (capabilities) {
            prompt.push('# CAPABILITIES')
            prompt.push(capabilities.map(o => `- ${o}`).join('\n'))
        }

        if (rulesOut?.length > 0) {
            prompt.push('# RULES')
            prompt.push(rulesOut.map(o => `- ${o}`).join('\n'))
        }

        if (restrictionsOut?.length > 0) {
            prompt.push('# RESTRICTIONS')
            prompt.push(restrictionsOut.map(o => `- ${o}`).join('\n'))
        }

        if (commands?.length > 0) {
            const state = context.state ?? 'default'
            prompt.push('# COMMANDS')
            prompt.push(commands.map(c => {
                const lines = []

                // desc: sempre a descrição principal (note 'in', state null)
                const desc = c.notes?.find(n => n.context === 'in' && n.state === null)?.text ?? ''

                // notes 'out' filtradas por estado — todas aparecem como extra
                const extra = c.notes?.filter(n =>
                    n.context === 'out' && (n.state === null || n.state === state)
                ) ?? []

                lines.push(`[${c.method}]${desc ? ' -> ' + desc : ''}`)

                if (extra.length) {
                    lines.push('  notes:')
                    for (const n of extra) lines.push(`    - ${n.text}`)
                }

                if (c.outputs?.length) {
                    lines.push('  output:')
                    for (const o of c.outputs) lines.push(`    - ${o.name}: ${o.desc}`)
                }

                return lines.join('\n')
            }).join('\n\n'))
        }

        if (memoryContext) {
            prompt.push('# MEMORY_CONTEXT')
            prompt.push(memoryContext)
        }

        if (chatHistory) {
            prompt.push('# CHAT_HISTORY')
            prompt.push(chatHistory)
        }

        if (chatInput) {
            prompt.push('# CHAT_INPUT')
            prompt.push(chatInput)
        }

        if (data) {
            prompt.push('# INPUT_RAW_DATA')
            prompt.push(data)
        }

        return prompt.join('\n\n')
    }

    async send(contextId, content, commands) {

        const context = await this.getContext(contextId, true)

        const msg = {
            role: 'user',
            content,
            commands
        }
        context.messages.push(msg)

        setImmediate(this.processMessageBind, context)

        return msg
    }

    async receive(contextId, timeout = 30_000) {

        const context = await this.getContext(contextId)
        if (!context) {
            return undefined
        }

        let msg = context.messages[context.messages.length - 1]
        if (msg?.role == 'agent') {
            return msg
        }

        if (timeout > 0) {
            msg = await context.messagesSignal.wait(timeout)
            if (msg?.role) {
                return msg
            }
            return this.receive(contextId, 0)
        }

        return {
            role: 'system',
            content: 'working'
        }
    }

    /**
     * Pré-filtra os comandos candidatos pelo router de intenções (embeddings MiniLM
     * offline). Devolve um mapa { method: true } com o top-K + os comandos de
     * sistema (greetings/notFound) sempre presentes como escape. Sem router
     * disponível (EnvUtils 'intentRouter'), devolve undefined → getPromptIn mantém
     * todos os comandos (comportamento original, não-quebrável).
     */
    async routeCandidateCommands(text, context) {
        const router = EnvUtils.getInstance('intentRouter')
        if (!router || !router.ready) {
            return undefined
        }
        try {
            const routed = await router.route(text)
            if (!routed || !routed.methods || routed.methods.length === 0) {
                return undefined
            }
            const filter = {}
            for (const m of routed.methods) {
                filter[m] = true
            }
            filter['greetings'] = true
            filter['notFound'] = true
            context.lastRoute = { methods: routed.methods, agents: routed.agents, abstained: routed.abstained }
            return filter
        } catch (err) {
            console.error('[Router] falha ao rotear, usando todos os comandos:', err.message)
            return undefined
        }
    }

    processMessageBind = this.processMessage.bind(this)
    async processMessage(context) {

        try {

            const msg = context.messages[context.messages.length - 1]
            const msgContent = msg.content
            if (msgContent == 'reset') {
                return await this.reset(context, true)
            }

            const msgCommands = msg.commands
            delete msg.commands

            await context.agent?.onBeforeProcessMessage?.()

            // Pré-filtro de intenção pelo router de embeddings (substitui o antigo
            // getPromptPre em duas passadas de LLM): reduz os ~48 comandos tagueados a
            // um top-K enxuto ANTES da LLM. Sem router disponível, filterCommands fica
            // undefined e getPromptIn usa todos os comandos (comportamento original).
            let mcmds = []
            if (msgContent?.length) {
                const filterCommands = await this.routeCandidateCommands(msgContent, context)
                const promptIn = this.getPromptIn(context, filterCommands)
                // fs.writeFileSync('./prompt-in-data.txt', promptIn)

                mcmds = await this.llmService.execute(promptIn, 'json')
                mcmds = mcmds
                    .map(group => group.filter(cmd => context.agent.isCommandAvailable?.(cmd.type) ?? true))
                    .filter(group => group.length > 0)

                if (msgCommands) {
                    if (mcmds.length == 1 && mcmds[0].type == 'notFound') {
                        mcmds = []
                    }
                    mcmds = [msgCommands, ...mcmds]
                }
            } else {
                mcmds = [msgCommands]
            }

            let mres = []
            let interrupt = undefined
            let filterCommands = {}

            msg.commands = structuredClone(mcmds)
            msg.resolved = undefined
            msg.interrupt = undefined
            msg.state = context.state
            msg.stateNext = null

            let resolved = await this.resolve(context, mcmds)
            if (resolved) {
                context.state = resolved.state || 'default'
                if (AgentRuntime.isInterrupt(resolved)) {
                    interrupt = resolved
                    resolved = AgentRuntime.instruction(resolved.data, resolved.instruction)
                }
                mres.push([resolved])
            } else {
                context.state = 'default'
            }

            if (!interrupt) {

                if (context.pendingCommands) {
                    mcmds.splice(0, 0, ...context.pendingCommands)
                    context.pendingCommands = undefined
                }

                await context.agent?.onBeforeProcessCommands?.(mcmds, mres)

                while (mcmds.length > 0) {
                    const cmds = mcmds[0]
                    mcmds.splice(0, 1)

                    const ress = []
                    while (cmds.length > 0) {
                        const cmd = cmds[0]
                        cmds.splice(0, 1)

                        filterCommands[cmd.type] = true
                        let res = await this.processCommand(context, cmd)

                        if (!res) {
                            continue
                        }

                        if (res.state) {
                            context.state = res.state
                        }

                        if (AgentRuntime.isInterrupt(res)) {
                            interrupt = res
                            res = AgentRuntime.instruction(res.data, res.instruction)
                        }

                        ress.push(res)

                        if (interrupt) {
                            break
                        }
                    }

                    if (ress.length > 0) {
                        mres.push(ress)
                    }

                    if (interrupt) {
                        if (cmds.length > 0) {
                            mcmds.splice(0, 0, cmds)
                        }
                        break
                    }
                }
            }

            if (interrupt?.state) {
                context.state = interrupt.state
            }

            context.commandInterrupt = interrupt

            if (mcmds.length > 0) {
                if (context.pendingCommands) {
                    context.pendingCommands = [...context.pendingCommands, ...mcmds]
                } else {
                    context.pendingCommands = mcmds
                }
            }

            await context.agent?.onAfterProcessCommands?.(mcmds, mres)

            if (!msgContent) {
                return
            }

            if (!mres.length) {
                mres.push([AgentRuntime.instruction('nenhuma solicitação atendida. Se não houver conteúdo relevante na resposta, apresente sugestão do que fazer em seguida considerando histórico recente de mensagens.')])
            }

            msg.resolved = resolved ? structuredClone(resolved) : undefined
            msg.interrupt = interrupt ? structuredClone(interrupt) : undefined
            msg.stateNext = context.state
            msg.results = structuredClone(mres)

            const data = JSON.stringify(mres)

            let res = await context.agent.getMessage()

            if (!res) {
                filterCommands = Object.keys(filterCommands)
                const promptOut = this.getPromptOut(context, data, filterCommands, interrupt)
                // fs.writeFileSync('./prompt-out-data.txt', promptOut)
                res = await this.llmService.execute(promptOut, 'text')
            }
            res = { role: 'agent', content: res }

            context.messages.push(res)
            context.messagesSignal.set()

        } catch (err) {
            console.error('[Error] [processMessage]', err)
            context.messagesSignal.set()
        }
    }

    async resolve(context, mcmds) {

        const key = `resolve${context.state}`
        const fn = typeof context.agent[key] === 'function' ? context.agent[key] : undefined
        if (!fn) {
            return undefined
        }

        let res = undefined

        outer:
        for (let i = 0; i < mcmds.length; i++) {
            const cmds = mcmds[i]
            for (let j = 0; j < cmds.length; j++) {
                try { res = await fn.call(context.agent, cmds[j]) }
                catch { }
                if (res) {
                    cmds.splice(j, 1)
                    if (!cmds.length) {
                        mcmds.splice(i, 1)
                    }
                    break outer
                }
            }
        }

        if (!res) {
            try { res = await fn.call(context.agent, { type: 'notResolved' }) }
            catch { }
        }

        if (res && !AgentRuntime.isInterrupt(res)) {
            res = AgentRuntime.resolve(res, res.state || 'default')
        }

        return res
    }

    async processCommand(context, cmd) {

        try {
            const { type } = cmd

            // gate de versão — bloqueia comando indisponível para a versão do chat.
            // cobre comandos injetados via req.data.commands, que escapam do filtro pós-LLM.
            if (!(context.agent.isCommandAvailable?.(type) ?? true)) {
                return undefined
            }

            const target = typeof context.agent[type] === 'function'
                ? context.agent
                : typeof this[type] === 'function'
                    ? this
                    : null

            if (!target) {
                console.warn(`processCommand: command not found [${type}]`)
                return AgentRuntime.instruction(cmd, 'comando não produziu resultados')
            }

            return await target[type](cmd)

        } catch (e) {
            console.error('Error processing command', cmd, e)
            return AgentRuntime.instruction(cmd, 'informe erro ao processar a solicitação.')
        }
    }

    /* # COMMAND
    representa uma saudação, apresentação ou mensagem de abertura de conversa sem intenção operacional clara
    */
    async greetings() {
        return AgentRuntime.instruction('greetings', 'cumprimente o usuário de forma breve e apresente suas capacidades')
    }

    /* # COMMAND
    sinaliza que não existe nenhuma atuação possível para a intenção do usuário
    @input description: str -> descrição textual da intenção original do usuário
    */
    async notFound({ description }) {
        return AgentRuntime.instruction('notFound', `intenção não reconhecida: ${description}`)
    }

    getData(contextId) {
        const context = this.contexts[contextId]
        if (!context) {
            return undefined
        }
        return context?.agent?.getData?.()
    }

    getMessages(contextId, { role, count, audit } = {}) {

        const context = this.contexts[contextId]
        if (!context) {
            return undefined
        }

        let messages = context.messages ?? []

        if (role) {
            messages = messages.filter(msg => msg.role === role)
        }

        if (count > 0) {
            messages = messages.slice(-count)
        }

        if (audit) {
            return messages
        }

        return messages.map(msg => ({
            role: msg.role,
            content: msg.content
        }))
    }

    static instruction(cmd, instruction) {
        if (typeof cmd === 'string' && !instruction) {
            instruction = cmd
            return { type: 'instruction', instruction }
        } else if (typeof cmd === 'string') {
            return { type: cmd, instruction }
        }

        return { ...cmd, instruction }
    }

    static isInstruction(res) {
        return res?.type == 'instruction' || res?.instruction != undefined
    }

    static interrupt(data, instruction, state) {

        if (typeof data === 'string' && !state) {
            state = instruction
            instruction = data
            data = undefined
        }

        return { type: 'interrupt', data, instruction, state }
    }

    static isInterrupt(res) {
        return res?.type == 'interrupt'
    }

    static resolve(data, instruction, state) {

        if (typeof data === 'string' && !state) {
            state = instruction
            instruction = data
            data = undefined
        }

        return { type: 'resolve', data, instruction, state }
    }

    static isResolve(res) {
        return res?.type == 'resolve'
    }
}

module.exports = { AgentRuntime }