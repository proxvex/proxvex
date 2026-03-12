import type { ISshConfigsResponse, IApplicationsResponse, IUnresolvedParametersResponse, IEnumValuesResponse, ICompatibleAddonsResponse, IStacktypesResponse, IStacksResponse, IPostVeConfigurationBody, IPostVeConfigurationResponse, IVeExecuteMessagesResponse } from "../../backend/src/types.mjs";
import type { ValidationResult } from "../../backend/src/parameter-validator.mjs";
export declare class CliApiClient {
    private baseUrl;
    private token?;
    private fixtureDir?;
    private fixtureIndex;
    constructor(baseUrl: string, token?: string, insecure?: boolean, fixturePath?: string);
    private request;
    private pollingFixtureFile?;
    private saveFixture;
    getSshConfigs(): Promise<ISshConfigsResponse>;
    getSshConfigKey(host: string): Promise<{
        key: string;
    }>;
    getApplications(): Promise<IApplicationsResponse>;
    getUnresolvedParameters(veCtx: string, app: string, task: string): Promise<IUnresolvedParametersResponse>;
    postEnumValues(veCtx: string, app: string, task: string): Promise<IEnumValuesResponse>;
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
    postVeConfiguration(veCtx: string, app: string, task: string, body: Omit<IPostVeConfigurationBody, "task">): Promise<IPostVeConfigurationResponse>;
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
