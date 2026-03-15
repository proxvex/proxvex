//

import { ApiUri, ISsh, IApplicationsResponse, ISshConfigsResponse, ISshConfigKeyResponse, ISshCheckResponse, IUnresolvedParametersResponse, IDeleteSshConfigResponse, IPostVeConfigurationResponse, IPostVeConfigurationBody, IPostAddonInstallBody, IPostSshConfigResponse, IVeExecuteMessagesResponse, IFrameworkNamesResponse, IFrameworkParametersResponse, IPostFrameworkCreateApplicationBody, IPostFrameworkCreateApplicationResponse, IPostFrameworkFromImageBody, IPostFrameworkFromImageResponse, IApplicationFrameworkDataResponse, IInstallationsResponse, IVeConfigurationResponse, ITemplateProcessorLoadResult, IEnumValuesResponse, IPostEnumValuesBody, ITagsConfigResponse, ICompatibleAddonsResponse, IStacktypesResponse, IStacksResponse, IStackResponse, IStack, IFrameworkApplicationDataBody, ICertificateStatusResponse, IPostCertRenewBody, IPostCertRenewResponse, IPostCaImportBody, ICaInfoResponse, ICertificateStatus, IPostGenerateCertBody, IGenerateCertResponse } from '../shared/types';
import { ICreateStackResponse } from '../shared/types-frontend';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { IApplicationWeb, IParameterValue } from '../shared/types';
import { ErrorHandlerService } from './shared/services/error-handler.service';



export interface VeConfigurationParam { name: string; value: IParameterValue }

@Injectable({
  providedIn: 'root',
})
export class VeConfigurationService {
  private http = inject(HttpClient);
  private router = inject(Router);
  private errorHandler = inject(ErrorHandlerService);
  private veContextKey?: string;
  // Explicit initializer: call early (e.g., AppComponent.ngOnInit or APP_INITIALIZER)
  initVeContext(): Observable<ISsh[]> {
    return this.getSshConfigs().pipe(
      map((res: ISshConfigsResponse) => res.sshs)
    );
  }

  private handleError(err: Error & { error: {error?: string; serializedError?: unknown};errors?: Error; status?: number; message?: string }) {
    // Log serializedError to console if available
    if (err?.error && typeof err.error === 'object' && 'serializedError' in err.error) {
      console.error('Serialized Error:', err.error.serializedError);
    }

    this.errorHandler.handleError('Request failed', err, true);
    this.router.navigate(['/']);
    return throwError(() => err);
  }
  // Stack VE context key returned by backend so we can append it to future calls when required
  private setVeContextKeyFrom(response: unknown) {
    if (response && typeof response === 'object') {
      const obj = response as Record<string, unknown>;
      const keyVal = obj['key'];
      if (typeof keyVal === 'string' && keyVal.length > 0) {
        this.veContextKey = keyVal;
      }
    }
  }
  post <T, U>(url:string, body:U):Observable<T> {
    return this.http.post<T>(this.veContextKey? url.replace(":veContext", this.veContextKey) : url, body).pipe(
      catchError((err) => this.handleError(err))
    )
  }
  
  // Post without global error handling - caller must handle errors
  postWithoutGlobalErrorHandler<T, U>(url:string, body:U):Observable<T> {
    return this.http.post<T>(this.veContextKey? url.replace(":veContext", this.veContextKey) : url, body);
  }
  
  get<T>(url:string):Observable<T> {
    return this.http.get<T>(this.veContextKey? url.replace(":veContext", this.veContextKey) : url).pipe(
      catchError((err) => this.handleError(err))
    )
  }

  getVeContextKey(): string | undefined {
    return this.veContextKey;
  }
  getApplications(): Observable<IApplicationWeb[]> {
    return this.http.get<IApplicationsResponse>(ApiUri.Applications);
  }

  getLocalApplicationIds(): Observable<string[]> {
    return this.http.get<string[]>(ApiUri.LocalApplicationIds);
  }

  getTagsConfig(): Observable<ITagsConfigResponse> {
    return this.http.get<ITagsConfigResponse>(ApiUri.ApplicationTags);
  }

  getInstallations(): Observable<IInstallationsResponse> {
    return this.get<IInstallationsResponse>(ApiUri.Installations);
  }

  getUnresolvedParameters(application: string, task: string): Observable<IUnresolvedParametersResponse> {
    const base = ApiUri.UnresolvedParameters
      .replace(":application", encodeURIComponent(application));
    const url = (this.veContextKey ? base.replace(":veContext", this.veContextKey) : base)
      + `?task=${encodeURIComponent(task)}`;
    return this.http.get<IUnresolvedParametersResponse>(url);
  }

  getTemplateTrace(application: string, task: string): Observable<ITemplateProcessorLoadResult> {
    const base = ApiUri.TemplateDetailsForApplication
      .replace(":application", encodeURIComponent(application))
      .replace(":task", encodeURIComponent(task));
    const url = this.veContextKey ? base.replace(":veContext", this.veContextKey) : base;
    return this.http.get<ITemplateProcessorLoadResult>(url);
  }

  postEnumValues(application: string, task: string, params?: { id: string; value: IParameterValue }[], refresh?: boolean): Observable<IEnumValuesResponse> {
    const url = ApiUri.EnumValues
      .replace(':application', encodeURIComponent(application));
    const body: IPostEnumValuesBody = { task };
    if (params && params.length > 0) body.params = params;
    if (refresh === true) body.refresh = true;
    return this.post<IEnumValuesResponse, IPostEnumValuesBody>(url, body);
  }

  getSshConfigs(): Observable<ISshConfigsResponse> {
    return this.get<ISshConfigsResponse>(ApiUri.SshConfigs).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
    );
  }

  getSshConfigKey(host: string): Observable<ISshConfigKeyResponse> {
    const url = ApiUri.SshConfigGET.replace(':host', encodeURIComponent(host));
    return this.get<ISshConfigKeyResponse>(url).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
    );
  }

  checkSsh(host: string, port?: number): Observable<ISshCheckResponse> {
    const params = new URLSearchParams({ host });
    if (typeof port === 'number') params.set('port', String(port));
    return this.get<ISshCheckResponse>(`${ApiUri.SshCheck}?${params.toString()}`);
  }

  postVeConfiguration(application: string, task: string, params: VeConfigurationParam[], changedParams?: VeConfigurationParam[], selectedAddons?: string[], disabledAddons?: string[], stackId?: string, installedAddons?: string[]): Observable<{ success: boolean; restartKey?: string; vmInstallKey?: string }> {
    const url = ApiUri.VeConfiguration
      .replace(':application', encodeURIComponent(application));
    const body: IPostVeConfigurationBody = { task, params };
    if (changedParams && changedParams.length > 0) {
      body.changedParams = changedParams;
    }
    if (selectedAddons && selectedAddons.length > 0) {
      body.selectedAddons = selectedAddons;
    }
    if (disabledAddons && disabledAddons.length > 0) {
      body.disabledAddons = disabledAddons;
    }
    if (installedAddons && installedAddons.length > 0) {
      body.installedAddons = installedAddons;
    }
    if (stackId) {
      body.stackId = stackId;
    }
    return this.post<IPostVeConfigurationResponse,IPostVeConfigurationBody>(url, body).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
    );
  }

  postVeUpgrade(application: string, body: { source_vm_id: number; oci_image: string; application_id?: string; application_name?: string; version?: string; addons?: string[] }): Observable<IVeConfigurationResponse> {
    const params: VeConfigurationParam[] = [];
    const add = (name: string, value: string | number | boolean | undefined) => {
      if (value !== undefined && value !== null) params.push({ name, value });
    };
    add('source_vm_id', body.source_vm_id);
    add('oci_image', body.oci_image);
    add('application_id', body.application_id);
    add('application_name', body.application_name);
    add('version', body.version);
    return this.postVeConfiguration(application, 'upgrade', params, undefined, body.addons);
  }

  postAddonInstall(addonId: string, body: IPostAddonInstallBody): Observable<IVeConfigurationResponse> {
    const url = ApiUri.AddonInstall.replace(':addonId', encodeURIComponent(addonId));
    return this.post<IVeConfigurationResponse, IPostAddonInstallBody>(url, body);
  }

  setSshConfig(ssh: ISsh): Observable<IPostSshConfigResponse> {
    return this.post<IPostSshConfigResponse, ISsh>(ApiUri.SshConfig, ssh).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      catchError((err) => this.handleError(err))
    );
  }

  deleteSshConfig(host: string): Observable<IDeleteSshConfigResponse> {
    const params = new URLSearchParams({ host });
    return this.http.delete<IDeleteSshConfigResponse>(`${ApiUri.SshConfig}?${params.toString()}`).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      catchError((err) => this.handleError(err))
    );
  }
  getExecuteMessages(): Observable<IVeExecuteMessagesResponse> {
    return  this.get<IVeExecuteMessagesResponse>(ApiUri.VeExecute);
  }
  
  restartExecution(restartKey: string): Observable<IPostVeConfigurationResponse> {
    if (!this.veContextKey) {
      return throwError(() => new Error("VE context not set"));
    }
    // Note: post() already replaces :veContext, so only replace :restartKey here
    // Parameters are contained in the restart context, no need to send them
    const url = ApiUri.VeRestart.replace(':restartKey', encodeURIComponent(restartKey));
    return this.post<IPostVeConfigurationResponse, object>(url, {});
  }

  restartInstallation(vmInstallKey: string): Observable<IPostVeConfigurationResponse> {
    if (!this.veContextKey) {
      return throwError(() => new Error("VE context not set"));
    }
    // Note: post() already replaces :veContext, so only replace :vmInstallKey here
    const url = ApiUri.VeRestartInstallation.replace(':vmInstallKey', encodeURIComponent(vmInstallKey));
    return this.post<IPostVeConfigurationResponse, object>(url, {}).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
    );
  }

  getFrameworkNames(): Observable<IFrameworkNamesResponse> {
    return this.get<IFrameworkNamesResponse>(ApiUri.FrameworkNames);
  }

  getFrameworkParameters(frameworkId: string): Observable<IFrameworkParametersResponse> {
    const url = ApiUri.FrameworkParameters.replace(':frameworkId', encodeURIComponent(frameworkId));
    return this.get<IFrameworkParametersResponse>(url);
  }

  createApplicationFromFramework(body: IPostFrameworkCreateApplicationBody): Observable<IPostFrameworkCreateApplicationResponse> {
    // Use http.post directly to avoid catchError in post() method
    // This allows the component to handle errors itself
    const url = this.veContextKey 
      ? ApiUri.FrameworkCreateApplication.replace(":veContext", this.veContextKey) 
      : ApiUri.FrameworkCreateApplication;
    return this.http.post<IPostFrameworkCreateApplicationResponse>(url, body);
  }

  getFrameworkFromImage(body: IPostFrameworkFromImageBody): Observable<IPostFrameworkFromImageResponse> {
    // Use postWithoutGlobalErrorHandler to allow caller to handle errors (e.g., for debounced input validation)
    return this.postWithoutGlobalErrorHandler<IPostFrameworkFromImageResponse, IPostFrameworkFromImageBody>(ApiUri.FrameworkFromImage, body);
  }

  getApplicationFrameworkData(applicationId: string): Observable<IApplicationFrameworkDataResponse> {
    const url = ApiUri.ApplicationFrameworkData.replace(':applicationId', encodeURIComponent(applicationId));
    return this.http.get<IApplicationFrameworkDataResponse>(url);
  }

  getPreviewUnresolvedParameters(body: IFrameworkApplicationDataBody): Observable<IUnresolvedParametersResponse> {
    // Use postWithoutGlobalErrorHandler to allow caller to handle errors
    return this.postWithoutGlobalErrorHandler<IUnresolvedParametersResponse, IFrameworkApplicationDataBody>(
      ApiUri.PreviewUnresolvedParameters,
      body
    );
  }

  getCompatibleAddons(application: string, installedAddonIds?: string[]): Observable<ICompatibleAddonsResponse> {
    let url = ApiUri.CompatibleAddons
      .replace(':application', encodeURIComponent(application));
    if (installedAddonIds?.length) {
      url += `?installed=${encodeURIComponent(installedAddonIds.join(','))}`;
    }
    return this.http.get<ICompatibleAddonsResponse>(url);
  }

  // Stack management methods
  getStacktypes(): Observable<IStacktypesResponse> {
    return this.http.get<IStacktypesResponse>(ApiUri.Stacktypes);
  }

  getStacks(stacktype?: string): Observable<IStacksResponse> {
    let url: string = ApiUri.Stacks;
    if (stacktype) {
      url += `?stacktype=${encodeURIComponent(stacktype)}`;
    }
    return this.http.get<IStacksResponse>(url);
  }

  getStack(id: string): Observable<IStackResponse> {
    const url = ApiUri.Stack.replace(':id', encodeURIComponent(id));
    return this.http.get<IStackResponse>(url);
  }

  createStack(stack: Omit<IStack, 'id'>): Observable<ICreateStackResponse> {
    return this.http.post<ICreateStackResponse>(ApiUri.Stacks, stack);
  }

  updateStack(stack: IStack): Observable<ICreateStackResponse> {
    return this.http.post<ICreateStackResponse>(ApiUri.Stacks, stack);
  }

  deleteStack(id: string): Observable<{ success: boolean; deleted: boolean }> {
    const url = ApiUri.Stack.replace(':id', encodeURIComponent(id));
    return this.http.delete<{ success: boolean; deleted: boolean }>(url);
  }

  // Certificate management methods
  getCertificateStatus(): Observable<ICertificateStatusResponse> {
    return this.get<ICertificateStatusResponse>(ApiUri.CertificateStatus);
  }

  postCertificateRenew(body: IPostCertRenewBody): Observable<IPostCertRenewResponse> {
    return this.post<IPostCertRenewResponse, IPostCertRenewBody>(ApiUri.CertificateRenew, body);
  }

  getCaInfo(): Observable<ICaInfoResponse> {
    return this.get<ICaInfoResponse>(ApiUri.CertificateCa);
  }

  postCaImport(body: IPostCaImportBody): Observable<ICaInfoResponse> {
    return this.post<ICaInfoResponse, IPostCaImportBody>(ApiUri.CertificateCa, body);
  }

  postCaGenerate(): Observable<ICaInfoResponse> {
    return this.post<ICaInfoResponse, object>(ApiUri.CertificateCaGenerate, {});
  }

  getPveStatus(): Observable<ICertificateStatus> {
    return this.get<ICertificateStatus>(ApiUri.CertificatePveStatus);
  }

  postPveProvision(): Observable<{ success: boolean }> {
    return this.post<{ success: boolean }, object>(ApiUri.CertificatePveProvision, {});
  }

  postDomainSuffix(suffix: string): Observable<{ success: boolean; domain_suffix: string }> {
    return this.post<{ success: boolean; domain_suffix: string }, object>(ApiUri.CertificateDomainSuffix, { domain_suffix: suffix });
  }

  downloadCaCert(): Observable<Blob> {
    const url = this.veContextKey ? ApiUri.CertificateCaDownload.replace(':veContext', this.veContextKey) : ApiUri.CertificateCaDownload;
    return this.http.get(url, { responseType: 'blob' }).pipe(
      catchError((err) => this.handleError(err)),
    );
  }

  postGenerateCert(hostname: string): Observable<IGenerateCertResponse> {
    return this.post<IGenerateCertResponse, IPostGenerateCertBody>(ApiUri.CertificateGenerate, { hostname });
  }

  saveTestData(applicationId: string, body: {
    scenarioName: string;
    params: { name: string; value: string | number | boolean }[];
    uploads?: { name: string; content: string }[];
    addons?: string[];
  }): Observable<{ success: boolean; testsDir: string }> {
    const url = ApiUri.ApplicationTestData.replace(':applicationId', encodeURIComponent(applicationId));
    return this.http.post<{ success: boolean; testsDir: string }>(url, body);
  }

}
