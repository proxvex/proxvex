import type {
  IParameter,
  IAddonWithParameters,
  IStack,
} from "@shared/types.mjs";

export class CliTemplateGenerator {
  generate(input: {
    application: string;
    task: string;
    parameters: IParameter[];
    addons: IAddonWithParameters[];
    stacks: IStack[];
    stacktype?: string | string[];
  }): object {
    const params = input.parameters.map((p) => {
      const entry: Record<string, unknown> = {
        name: p.id,
        value: p.default ?? (p.type === "number" ? 0 : p.type === "boolean" ? false : ""),
      };
      if (p.required) entry.$required = true;
      entry.$type = p.type;
      if (p.description) entry.$description = p.description;
      if (p.upload) entry.$upload = true;
      if (p.type === "enum" && p.enumValues) {
        entry.$enumValues = p.enumValues.map((ev) =>
          typeof ev === "string" ? ev : ev.value,
        );
      }
      return entry;
    });

    const availableAddons = input.addons.map((a) => ({
      $id: a.id,
      $name: a.name,
      ...(a.description ? { $description: a.description } : {}),
    }));

    const availableStacks = input.stacks.map((s) => ({
      $id: s.id,
      $name: s.name,
    }));

    const result: Record<string, unknown> = {
      $comment: `Generated template for: ${input.application} / ${input.task}`,
      params,
      addons: [],
      availableAddons,
      stackId: "",
      availableStacks,
    };

    const stacktypeLabel = input.stacktype ? (Array.isArray(input.stacktype) ? input.stacktype.join(', ') : input.stacktype) : undefined;
    if (stacktypeLabel && input.stacks.length === 0) {
      result.$stackComment =
        `This application requires a '${stacktypeLabel}' stack for shared secrets (e.g. database passwords). ` +
        `No stacks exist yet — one will be created automatically with generated secrets. ` +
        `Leave stackId empty to use 'default', or set a custom name (e.g. 'production') to create a named stack.`;
    }

    return result;
  }
}
