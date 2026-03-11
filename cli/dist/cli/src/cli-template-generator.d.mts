import type { IParameter, IAddonWithParameters, IStack } from "../../backend/src/types.mjs";
export declare class CliTemplateGenerator {
    generate(input: {
        application: string;
        task: string;
        parameters: IParameter[];
        addons: IAddonWithParameters[];
        stacks: IStack[];
        stacktype?: string | string[];
    }): object;
}
