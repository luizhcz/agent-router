import { riskAgent, riskCommands } from './risk.js';
import { traderAgent, traderCommands } from './trader.js';
import { contentAgent, contentCommands } from './content.js';
import { publicOfferingsAgent, publicOfferingsCommands } from './public-offerings.js';
export const catalog = {
    agents: [riskAgent, traderAgent, contentAgent, publicOfferingsAgent],
    commands: [...riskCommands, ...traderCommands, ...contentCommands, ...publicOfferingsCommands],
};
const byId = new Map(catalog.commands.map((c) => [c.id, c]));
export function getCommand(id) {
    return byId.get(id);
}
export function commandsForAgent(agent) {
    return catalog.commands.filter((c) => c.agent === agent);
}
/**
 * Falha cedo em catálogo malformado — ids duplicados e utterances de menos são
 * os dois erros que degradam recall sem quebrar nada visivelmente.
 */
export function validateCatalog(c = catalog) {
    const problems = [];
    const seen = new Set();
    const agentIds = new Set(c.agents.map((a) => a.id));
    for (const cmd of c.commands) {
        if (seen.has(cmd.id))
            problems.push(`id duplicado: ${cmd.id}`);
        seen.add(cmd.id);
        if (!agentIds.has(cmd.agent))
            problems.push(`${cmd.id}: agente desconhecido "${cmd.agent}"`);
        if (!cmd.id.startsWith(`${cmd.agent}.`))
            problems.push(`${cmd.id}: id deveria começar com "${cmd.agent}."`);
        if (cmd.utterances.length < 8)
            problems.push(`${cmd.id}: só ${cmd.utterances.length} utterances (mínimo 8)`);
        if (cmd.keywords.length === 0)
            problems.push(`${cmd.id}: sem keywords`);
        if (!cmd.description.trim())
            problems.push(`${cmd.id}: sem descrição`);
        const dupUtt = cmd.utterances.filter((u, i) => cmd.utterances.indexOf(u) !== i);
        if (dupUtt.length)
            problems.push(`${cmd.id}: utterances duplicadas: ${dupUtt.join(' | ')}`);
        for (const p of cmd.params) {
            if (p.type === 'enum' && !p.enumValues?.length) {
                problems.push(`${cmd.id}: parâmetro enum "${p.name}" sem enumValues`);
            }
        }
    }
    for (const cmd of c.commands) {
        for (const other of cmd.confusableWith ?? []) {
            if (!seen.has(other))
                problems.push(`${cmd.id}: confusableWith aponta para id inexistente "${other}"`);
        }
    }
    return problems;
}
//# sourceMappingURL=index.js.map