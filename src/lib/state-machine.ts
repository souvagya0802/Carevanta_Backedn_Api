import { invalidTransition } from './errors.js';

/**
 * Explicit lifecycle definition. Status columns may only change through
 * `assertTransition`, and updates use optimistic concurrency
 * (`WHERE status = <from>`), so two concurrent transitions cannot both win.
 */
export type TransitionMap<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(map: TransitionMap<S>, from: S, to: S): boolean {
  return map[from]?.includes(to) ?? false;
}

export function assertTransition<S extends string>(entity: string, map: TransitionMap<S>, from: S, to: S): void {
  if (!canTransition(map, from, to)) throw invalidTransition(entity, from, to);
}

export function isTerminal<S extends string>(map: TransitionMap<S>, state: S): boolean {
  return (map[state]?.length ?? 0) === 0;
}
