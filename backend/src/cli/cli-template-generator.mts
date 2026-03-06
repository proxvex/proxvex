import type {
  IParameter,
  IAddonWithParameters,
  IStack,
} from "../types.mjs";

export class CliTemplateGenerator {
  generate(input: {
    application: string;
    task: string;
    parameters: IParameter[];
    addons: IAddonWithParameters[];
    stacks: IStack[];
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

    return {
      $comment: `Generated template for: ${input.application} / ${input.task}`,
      params,
      addons: [],
      availableAddons,
      stackId: "",
      availableStacks,
    };
  }
}
