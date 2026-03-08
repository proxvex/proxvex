import type { IParameter, IParameterValue, IAddonWithParameters, IStack } from "./types.mjs";
export interface ValidationError {
    field: string;
    message: string;
}
export interface ValidationWarning {
    field: string;
    message: string;
}
export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    warnings: ValidationWarning[];
}
export declare class ParameterValidator {
    validate(input: {
        params: {
            name: string;
            value: IParameterValue;
        }[];
        parameterDefs: IParameter[];
        selectedAddons?: string[];
        availableAddons?: IAddonWithParameters[];
        applicationParamIds?: Set<string>;
        stackId?: string;
        availableStacks?: IStack[];
    }): ValidationResult;
}
