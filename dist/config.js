/**
 * PimClaw configuration types and parser.
 */
export function parseConfig(raw) {
    if (!raw || typeof raw !== "object")
        return { autoCreateAgents: true };
    const obj = raw;
    const config = {
        autoCreateAgents: obj.autoCreateAgents !== false,
    };
    if (obj.perfMcp && typeof obj.perfMcp === "object") {
        const p = obj.perfMcp;
        if (typeof p.command === "string" && Array.isArray(p.args)) {
            config.perfMcp = {
                command: p.command,
                args: p.args,
                env: p.env ?? undefined,
            };
        }
    }
    if (obj.monMcp && typeof obj.monMcp === "object") {
        const m = obj.monMcp;
        if (typeof m.command === "string" && Array.isArray(m.args)) {
            config.monMcp = {
                command: m.command,
                args: m.args,
                env: m.env ?? undefined,
            };
        }
    }
    if (obj.simMcp && typeof obj.simMcp === "object") {
        const s = obj.simMcp;
        if (typeof s.command === "string" && Array.isArray(s.args)) {
            config.simMcp = {
                command: s.command,
                args: s.args,
                env: s.env ?? undefined,
            };
        }
    }
    return config;
}
//# sourceMappingURL=config.js.map