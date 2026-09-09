/**
 * Types for the KeeperHub execution extension for Lucid Agents.
 *
 * Every guarantee expressed here comes from a bug reproduced against the live
 * KeeperHub platform during the Agents Onchain hackathon. The numbered
 * references point at onboarding-teardown.md in github.com/Makabeez/carrydesk.
 */
/** Chain ids we accept. KeeperHub supports 20+; these are the ones under test. */
export const SUPPORTED_CHAINS = {
    ethereum: 1,
    base: 8453,
    sepolia: 11155111,
};
export function wei(value) {
    const s = typeof value === 'bigint' ? value.toString() : value.trim();
    if (!/^-?\d+$/.test(s)) {
        throw new TypeError(`wei() expects an integer string, received ${JSON.stringify(value)}. ` +
            `If this is a human-readable amount, use decimal() and convert with toWei().`);
    }
    return s;
}
export function decimal(value) {
    const s = typeof value === 'number' ? String(value) : value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
        throw new TypeError(`decimal() expects a decimal string, received ${JSON.stringify(value)}.`);
    }
    return s;
}
/** Convert a human-readable amount to wei without floating point. */
export function toWei(value, decimals) {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ''] = unsigned.split('.');
    if (fraction.length > decimals) {
        throw new RangeError(`${value} has ${fraction.length} decimal places but the token has ${decimals}. ` +
            `Refusing to silently truncate.`);
    }
    const padded = fraction.padEnd(decimals, '0');
    const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
    return wei(negative ? `-${combined}` : combined);
}
/** Convert wei to a human-readable amount without floating point. */
export function fromWei(value, decimals) {
    const negative = value.startsWith('-');
    const unsigned = negative ? value.slice(1) : value;
    const padded = unsigned.padStart(decimals + 1, '0');
    const whole = padded.slice(0, padded.length - decimals);
    const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '');
    const out = fraction ? `${whole}.${fraction}` : whole;
    return decimal(negative ? `-${out}` : out);
}
export class KeeperHubError extends Error {
    code;
    executionId;
    cause;
    constructor(message, code, executionId, cause) {
        super(message);
        this.code = code;
        this.executionId = executionId;
        this.cause = cause;
        this.name = 'KeeperHubError';
    }
}
export class VerificationError extends KeeperHubError {
    observed;
    constructor(message, observed, executionId) {
        super(message, 'VERIFICATION_FAILED', executionId);
        this.observed = observed;
        this.name = 'VerificationError';
    }
}
export class BudgetExceededError extends KeeperHubError {
    constructor(max, windowMs) {
        super(`Write budget exhausted: ${max} writes per ${windowMs}ms. ` +
            `Raise writeBudget deliberately if this is expected.`, 'BUDGET_EXCEEDED');
        this.name = 'BudgetExceededError';
    }
}
