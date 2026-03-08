import type { ISshConfigsResponse, IApplicationsResponse, IUnresolvedParametersResponse, IEnumValuesResponse, IPostEnumValuesBody, ICompatibleAddonsResponse, IStacktypesResponse, IStacksResponse, IPostVeConfigurationBody, IPostVeConfigurationResponse, IVeExecuteMessagesResponse } from "../../backend/src/types.mjs";
import type { ValidationResult } from "../../backend/src/parameter-validator.mjs";
export declare class CliApiClient {
    private baseUrl;
    private token?;
    constructor(baseUrl: string, token?: string, insecure?: boolean);
    private request;
    getSshConfigs(): Promise<ISshConfigsResponse>;
    getSshConfigKey(host: string): Promise<{
        key: string;
    }>;
    getApplications(): Promise<IApplicationsResponse>;
    getUnresolvedParameters(veCtx: string, app: string, task: string): Promise<IUnresolvedParametersResponse>;
    postEnumValues(veCtx: string, app: string, task: string, body: IPostEnumValuesBody): Promise<IEnumValuesResponse>;
    getCompatibleAddons(app: string): Promise<ICompatibleAddonsResponse>;
    getStacktypes(): Promise<IStacktypesResponse>;
    getStacks(stacktype?: string): Promise<IStacksResponse>;
    postValidateParameters(veCtx: string, app: string, task: string, body: {
        params: {
            name: string;
            value: any;
        }[];
        selectedAddons?: string[];
        disabledAddons?: string[];
        stackId?: string;
    }): Promise<ValidationResult>;
    postVeConfiguration(veCtx: string, app: string, task: string, body: IPostVeConfigurationBody): Promise<IPostVeConfigurationResponse>;
    postCreateStack(body: {
        name: string;
        stacktype: string;
        entries?: {
            name: string;
            value: string | number | boolean;
        }[];
    }): Promise<{
        success: boolean;
        key: string;
    }>;
    getContainerConfig(veCtx: string, vmId: number): Promise<Record<string, any>>;
    getExecuteMessages(veCtx: string): Promise<IVeExecuteMessagesResponse>;
    getValidation(): Promise<{
        valid: boolean;
        [key: string]: any;
    }>;
}
