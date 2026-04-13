import { IStack, IStacktypeEntry } from "../types.mjs";

/**
 * Stack provider interface.
 * Hub mode: local operations via ContextManager (LocalStackProvider).
 * Spoke mode: delegates to Hub API (RemoteStackProvider, Phase 5).
 */
export interface IStackProvider {
  listStacks(stacktype?: string): IStack[];
  getStack(id: string): IStack | null;
  addStack(stack: IStack): string;
  deleteStack(id: string): boolean;
}
