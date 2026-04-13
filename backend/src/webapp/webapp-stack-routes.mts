import express from "express";
import { ApiUri, IStack } from "../types.mjs";
import { IStackProvider } from "../services/stack-provider.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { generateSecret } from "../services/secrets-generator.service.mjs";

export class WebAppStack {
  private pm: PersistenceManager;

  constructor(
    private app: express.Application,
    private stackProvider: IStackProvider,
  ) {
    this.pm = PersistenceManager.getInstance();
  }

  init(): void {
    // GET /api/stacktypes - List all stacktypes
    this.app.get(ApiUri.Stacktypes, (_req, res) => {
      const stacktypes = this.pm.getStacktypes();
      res.json({ stacktypes });
    });

    // GET /api/stacks?stacktype=xxx - List all stacks (optionally filtered by stacktype)
    this.app.get(ApiUri.Stacks, (req, res) => {
      const stacktype = req.query.stacktype as string | undefined;
      const stacks = this.stackProvider.listStacks(stacktype);
      res.json({ stacks });
    });

    // GET /api/stack/:id - Get single stack
    this.app.get(ApiUri.Stack, (req, res) => {
      const stack = this.stackProvider.getStack(req.params.id);
      if (!stack) {
        res.status(404).json({ error: "Stack not found" });
        return;
      }
      res.json({ stack });
    });

    // POST /api/stacks - Create stack
    this.app.post(ApiUri.Stacks, express.json(), (req, res) => {
      const body = req.body as IStack;
      if (!body.name || !body.stacktype) {
        res
          .status(400)
          .json({ error: "Missing required fields: name, stacktype" });
        return;
      }
      // Auto-generate id from stacktype + name to ensure uniqueness across types
      const typePrefix = Array.isArray(body.stacktype) ? body.stacktype.sort().join('_') : body.stacktype;
      body.id = `${typePrefix}_${body.name}`;

      // Auto-generate secrets for variables without 'external' flag
      // Supports both single stacktype ("postgres") and array (["postgres", "oidc"])
      const pm = this.pm;
      const allStacktypes = pm.getStacktypes();
      const requestedTypes = Array.isArray(body.stacktype) ? body.stacktype : [body.stacktype];

      for (const typeName of requestedTypes) {
        const stacktypeDef = allStacktypes.find((st) => st.name === typeName);
        if (!stacktypeDef) continue;

        for (const variable of stacktypeDef.entries) {
          if (!variable.external) {
            const existing = body.entries.find((e) => e.name === variable.name);
            if (!existing || !existing.value) {
              const generated = generateSecret(variable.length ?? 32);
              if (existing) {
                existing.value = generated;
              } else {
                body.entries.push({ name: variable.name, value: generated });
              }
            }
          }
        }
      }

      const key = this.stackProvider.addStack(body);
      res.json({ success: true, key });
    });

    // DELETE /api/stack/:id - Delete stack
    this.app.delete(ApiUri.Stack, (req, res) => {
      const deleted = this.stackProvider.deleteStack(req.params.id);
      res.json({ success: deleted, deleted });
    });
  }
}
