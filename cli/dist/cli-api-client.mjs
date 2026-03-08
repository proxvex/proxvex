import { ConnectionError, AuthenticationError, NotFoundError, ApiError, } from "./cli-types.mjs";
export class CliApiClient {
    baseUrl;
    token;
    constructor(baseUrl, token, insecure) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        if (token)
            this.token = token;
        if (insecure) {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        }
    }
    async request(method, path, body) {
        const url = `${this.baseUrl}${path}`;
        const headers = {};
        if (this.token) {
            headers["Authorization"] = `Bearer ${this.token}`;
        }
        if (body !== undefined) {
            headers["Content-Type"] = "application/json";
        }
        const fetchOptions = { method, headers };
        if (body !== undefined) {
            fetchOptions.body = JSON.stringify(body);
        }
        let response;
        try {
            response = await fetch(url, fetchOptions);
        }
        catch (err) {
            throw new ConnectionError(`Cannot connect to ${this.baseUrl}: ${err?.message || err}`);
        }
        if (response.status === 401) {
            throw new AuthenticationError("Authentication required. Use --token.");
        }
        if (response.status === 403) {
            throw new AuthenticationError("Invalid token.");
        }
        if (response.status === 404) {
            throw new NotFoundError(`Not found: ${method} ${path}`);
        }
        if (!response.ok) {
            let detail = "";
            try {
                const errBody = await response.json();
                detail = errBody?.error || JSON.stringify(errBody);
            }
            catch {
                detail = await response.text();
            }
            throw new ApiError(`API error ${response.status} on ${method} ${path}: ${detail}`);
        }
        return (await response.json());
    }
    async getSshConfigs() {
        return this.request("GET", "/api/sshconfigs");
    }
    async getSshConfigKey(host) {
        return this.request("GET", `/api/ssh/config/${encodeURIComponent(host)}`);
    }
    async getApplications() {
        return this.request("GET", "/api/applications");
    }
    async getUnresolvedParameters(veCtx, app, task) {
        return this.request("GET", `/api/${veCtx}/unresolved-parameters/${encodeURIComponent(app)}/${encodeURIComponent(task)}`);
    }
    async postEnumValues(veCtx, app, task, body) {
        return this.request("POST", `/api/${veCtx}/enum-values/${encodeURIComponent(app)}/${encodeURIComponent(task)}`, body);
    }
    async getCompatibleAddons(app) {
        return this.request("GET", `/api/addons/compatible/${encodeURIComponent(app)}`);
    }
    async getStacktypes() {
        return this.request("GET", "/api/stacktypes");
    }
    async getStacks(stacktype) {
        const query = stacktype
            ? `?stacktype=${encodeURIComponent(stacktype)}`
            : "";
        return this.request("GET", `/api/stacks${query}`);
    }
    async postValidateParameters(veCtx, app, task, body) {
        return this.request("POST", `/api/${veCtx}/validate-parameters/${encodeURIComponent(app)}/${encodeURIComponent(task)}`, body);
    }
    async postVeConfiguration(veCtx, app, task, body) {
        return this.request("POST", `/api/${veCtx}/ve-configuration/${encodeURIComponent(app)}/${encodeURIComponent(task)}`, body);
    }
    async postCreateStack(body) {
        return this.request("POST", "/api/stacks", {
            ...body,
            entries: body.entries ?? [],
        });
    }
    async getExecuteMessages(veCtx) {
        return this.request("GET", `/api/${veCtx}/ve/execute`);
    }
    async getValidation() {
        return this.request("GET", "/api/validate");
    }
}
//# sourceMappingURL=cli-api-client.mjs.map