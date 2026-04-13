import { IStack } from "../types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { IStackProvider } from "./stack-provider.mjs";

/**
 * Local stack provider: delegates to ContextManager stack methods.
 * Used as the Hub/Standalone stack provider.
 */
export class LocalStackProvider implements IStackProvider {
  constructor(private contextManager: ContextManager) {}

  listStacks(stacktype?: string): IStack[] {
    return this.contextManager.listStacks(stacktype);
  }

  getStack(id: string): IStack | null {
    return this.contextManager.getStack(id);
  }

  addStack(stack: IStack): string {
    return this.contextManager.addStack(stack);
  }

  deleteStack(id: string): boolean {
    return this.contextManager.deleteStack(id);
  }
}
