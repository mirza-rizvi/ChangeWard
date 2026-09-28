import { LIMITS } from "./limits";

export class BudgetExceededError extends Error {
	constructor() {
		super("ChangeWard bridge-call budget exhausted");
		this.name = "BudgetExceededError";
	}
}

/**
 * Counts bridge calls (each `ctx.*` host call is a subrequest in the Cloudflare
 * sandbox) so one invocation never exceeds the platform limit.
 */
export class Budget {
	used = 0;

	constructor(readonly limit: number = LIMITS.bridgeCalls) {}

	get remaining(): number {
		return this.limit - this.used;
	}

	has(n = 1): boolean {
		return this.remaining >= n;
	}

	async call<T>(fn: () => Promise<T>): Promise<T> {
		if (!this.has(1)) throw new BudgetExceededError();
		this.used += 1;
		return fn();
	}
}
