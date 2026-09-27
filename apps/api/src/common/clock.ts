/** Injected so tests can control time; the engine never reads the system clock itself. */
export interface Clock { now(): Date }
export const CLOCK = Symbol("CLOCK");
export const systemClock: Clock = { now: () => new Date() };
