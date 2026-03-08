export class CliTemplateGenerator {
    generate(input) {
        const params = input.parameters.map((p) => {
            const entry = {
                name: p.id,
                value: p.default ?? (p.type === "number" ? 0 : p.type === "boolean" ? false : ""),
            };
            if (p.required)
                entry.$required = true;
            entry.$type = p.type;
            if (p.description)
                entry.$description = p.description;
            if (p.upload)
                entry.$upload = true;
            if (p.type === "enum" && p.enumValues) {
                entry.$enumValues = p.enumValues.map((ev) => typeof ev === "string" ? ev : ev.value);
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
        const result = {
            $comment: `Generated template for: ${input.application} / ${input.task}`,
            params,
            addons: [],
            availableAddons,
            stackId: "",
            availableStacks,
        };
        if (input.stacktype && input.stacks.length === 0) {
            result.$stackComment =
                `This application requires a '${input.stacktype}' stack for shared secrets (e.g. database passwords). ` +
                    `No stacks exist yet — one will be created automatically with generated secrets. ` +
                    `Leave stackId empty to use 'default', or set a custom name (e.g. 'production') to create a named stack.`;
        }
        return result;
    }
}
//# sourceMappingURL=cli-template-generator.mjs.map