//

import { ApiUri, ISsh, IApplicationsResponse, ISshConfigsResponse, ISshConfigKeyResponse, ISshCheckResponse, IUnresolvedParametersResponse, IDeleteSshConfigResponse, IPostVeConfigurationResponse, IPostVeConfigurationBody, IPostAddonInstallBody, IPostSshConfigResponse, IVeExecuteMessagesResponse, IVeExecuteMessage, IFrameworkNamesResponse, IFrameworkParametersResponse, IPostFrameworkCreateApplicationBody, IPostFrameworkCreateApplicationResponse, IPostFrameworkFromImageBody, IPostFrameworkFromImageResponse, IApplicationFrameworkDataResponse, IInstallationsResponse, IVeConfigurationResponse, ITemplateProcessorLoadResult, IEnumValuesResponse, IPostEnumValuesBody, ITagsConfigResponse, ICompatibleAddonsResponse, IStacktypesResponse, IStacksResponse, IStackResponse, IStack, IFrameworkApplicationDataBody, ICertificateStatusResponse, IPostCertRenewBody, IPostCertRenewResponse, IPostCaImportBody, ICaInfoResponse, ICertificateStatus, IPostGenerateCertBody, IGenerateCertResponse, IPostGenerateClientCertBody, IGenerateClientCertResponse, IAutoRenewalStatus, ILogRotationStatus, IReplacedCleanupStatus, ILockedContainer, ILockedCleanupResult, IDependencyCheckResponse, IContainerVersionsResponse, IApplicationOverviewResponse, IStackRestorePreviewRequest, IStackRestorePreviewResponse } from '../shared/types';
import { ICreateStackResponse } from '../shared/types-frontend';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, distinctUntilChanged, throwError } from 'rxjs';
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

  /**
   * Der in der Kopfzeile gewaehlte Proxmox-Host. Gesetzt von der App-Shell,
   * gelesen von Ansichten, die ihr Ziel anzeigen oder beim Wechsel neu laden
   * muessen (Process Monitor). Der veContextKey allein reicht dafuer nicht:
   * er ist ein Schluessel, kein anzeigbarer Name.
   */
  private currentHostSubject = new BehaviorSubject<string>('');
  readonly currentHost$ = this.currentHostSubject.asObservable().pipe(distinctUntilChanged());

  setCurrentHost(host: string): void {
    if (this.currentHostSubject.value !== host) {
      this.currentHostSubject.next(host);
    }
  }

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
  // Stack VE context key returned by backend so we can append it to future calls when required.
  // Clear the cached key when the response explicitly carries an empty/missing key —
  // otherwise a previously selected host stays "live" on the frontend after the
  // backend has dropped its current selection, and subsequent calls go to a stale ve_*.
  private setVeContextKeyFrom(response: unknown) {
    if (!response || typeof response !== 'object') return;
    const obj = response as Record<string, unknown>;
    if (!('key' in obj)) return;
    const keyVal = obj['key'];
    if (typeof keyVal === 'string' && keyVal.length > 0) {
      this.veContextKey = keyVal;
    } else {
      this.veContextKey = undefined;
    }
  }
  /**
   * Replace the `:veContext` placeholder. Throws if the URL needs a VE context
   * but none is selected — surfaces a clear error instead of letting the
   * request go out with a literal `:veContext` in the path (which would 404
   * on the backend with an opaque message).
   */
  private resolveVeContext(url: string): string {
    if (!url.includes(':veContext')) return url;
    if (!this.veContextKey) {
      throw new Error('Kein aktiver Proxmox-Host ausgewählt. Bitte oben in der Kopfzeile einen Host wählen.');
    }
    return url.replace(':veContext', this.veContextKey);
  }
  post <T, U>(url:string, body:U):Observable<T> {
    let resolved: string;
    try { resolved = this.resolveVeContext(url); } catch (err) { return throwError(() => err); }
    return this.http.post<T>(resolved, body).pipe(
      catchError((err) => this.handleError(err))
    )
  }

  // Post without global error handling - caller must handle errors
  postWithoutGlobalErrorHandler<T, U>(url:string, body:U):Observable<T> {
    let resolved: string;
    try { resolved = this.resolveVeContext(url); } catch (err) { return throwError(() => err); }
    return this.http.post<T>(resolved, body);
  }

  get<T>(url:string):Observable<T> {
    let resolved: string;
    try { resolved = this.resolveVeContext(url); } catch (err) { return throwError(() => err); }
    return this.http.get<T>(resolved).pipe(
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
    let resolved: string;
    try { resolved = this.resolveVeContext(base); } catch (err) { return throwError(() => err); }
    return this.http.get<IUnresolvedParametersResponse>(resolved + `?task=${encodeURIComponent(task)}`);
  }

  getApplicationOverview(applicationId: string, task: string, vmId?: number, veContextKey?: string): Observable<IApplicationOverviewResponse> {
    let url = ApiUri.ApplicationOverview
      .replace(':applicationId', encodeURIComponent(applicationId))
      + '?task=' + encodeURIComponent(task);
    if (vmId !== undefined) url += '&vm_id=' + vmId;
    if (veContextKey) url += '&veContext=' + encodeURIComponent(veContextKey);
    return this.http.get<IApplicationOverviewResponse>(url);
  }

  getTemplateTrace(application: string, task: string): Observable<ITemplateProcessorLoadResult> {
    const base = ApiUri.TemplateDetailsForApplication
      .replace(":application", encodeURIComponent(application))
      .replace(":task", encodeURIComponent(task));
    let resolved: string;
    try { resolved = this.resolveVeContext(base); } catch (err) { return throwError(() => err); }
    return this.http.get<ITemplateProcessorLoadResult>(resolved);
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

  postVeConfiguration(application: string, task: string, params: VeConfigurationParam[], changedParams?: VeConfigurationParam[], selectedAddons?: string[], disabledAddons?: string[], stackIds?: string[], installedAddons?: string[]): Observable<{ success: boolean; restartKey?: string; vmInstallKey?: string }> {
    const url = ApiUri.VeConfiguration
      .replace(':application', encodeURIComponent(application));
    // Ensure a debug bundle is collected for every UI-triggered task so the
    // "Download Diagnosis" button on the process-monitor has something to
    // pull. Backend's readDebugLevelFromInputs defaults to "off"; we override
    // here so the auto-download path is always armed. CLI/livetest set this
    // explicitly themselves, so they're unaffected. Users can still override
    // with a higher level by passing debug_level in params (e.g. "script").
    if (!params.some(p => p.name === 'debug_level')) {
      params = [...params, { name: 'debug_level', value: 'extLog' }];
    }
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
    if (stackIds && stackIds.length > 0) {
      body.stackIds = stackIds;
    }
    return this.post<IPostVeConfigurationResponse,IPostVeConfigurationBody>(url, body).pipe(
      tap((res) => this.setVeContextKeyFrom(res))
    );
  }

  getInstallationVersions(vmId: number): Observable<IContainerVersionsResponse> {
    const url = ApiUri.InstallationVersions.replace(':vmId', String(vmId));
    return this.get<IContainerVersionsResponse>(url);
  }

  postVeUpgrade(application: string, body: { previous_vm_id: number; oci_image: string; application_id?: string; application_name?: string; version?: string; addons?: string[]; target_versions?: string }): Observable<IVeConfigurationResponse> {
    const params: VeConfigurationParam[] = [];
    const add = (name: string, value: string | number | boolean | undefined) => {
      if (value !== undefined && value !== null) params.push({ name, value });
    };
    add('previous_vm_id', body.previous_vm_id);
    add('oci_image', body.oci_image);
    add('application_id', body.application_id);
    add('application_name', body.application_name);
    add('version', body.version);
    add('target_versions', body.target_versions);
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

  probeHub(hubApiUrl: string): Observable<{ ok: boolean; caFingerprint?: string; error?: string }> {
    return this.post<{ ok: boolean; caFingerprint?: string; error?: string }, { hubApiUrl: string }>(
      ApiUri.SpokeProbeHub,
      { hubApiUrl },
    ).pipe(catchError((err) => this.handleError(err)));
  }

  getSpokeSyncStatus(): Observable<{
    active: boolean;
    hubUrl?: string;
    hubId?: string;
    workspacePath?: string;
    synced?: boolean;
    syncedAt?: string;
  }> {
    return this.get<{
      active: boolean;
      hubUrl?: string;
      hubId?: string;
      workspacePath?: string;
      synced?: boolean;
      syncedAt?: string;
    }>(ApiUri.SpokeSync).pipe(catchError((err) => this.handleError(err)));
  }

  triggerSpokeSync(): Observable<{ ok: boolean; workspacePath?: string; syncedAt?: string; error?: string }> {
    return this.post<{ ok: boolean; workspacePath?: string; syncedAt?: string; error?: string }, Record<string, never>>(
      ApiUri.SpokeSync,
      {} as Record<string, never>,
    ).pipe(catchError((err) => this.handleError(err)));
  }

  deleteSshConfig(host: string): Observable<IDeleteSshConfigResponse> {
    const params = new URLSearchParams({ host });
    return this.http.delete<IDeleteSshConfigResponse>(`${ApiUri.SshConfig}?${params.toString()}`).pipe(
      tap((res) => this.setVeContextKeyFrom(res)),
      catchError((err) => this.handleError(err))
    );
  }
  getExecuteMessages(since?: number): Observable<IVeExecuteMessagesResponse> {
    const url = since !== undefined ? `${ApiUri.VeExecute}?since=${since}` : ApiUri.VeExecute;
    return  this.get<IVeExecuteMessagesResponse>(url);
  }

  /**
   * SSE stream for real-time execution message updates.
   *
   * Emits 'snapshot' (full state) on connect, then 'message' for each new
   * message. Auto-reconnects on CLOSED with exponential backoff capped at
   * 30s — required for self-upgrade/reconfigure flows where the deployer
   * CT gets replaced mid-task: the old EventSource dies definitively, and
   * without reconnect the UI would freeze on the last seen state.
   *
   * Dedup: consumers see every message that the server emitted, but
   * subscribers should treat `msg.index` as the canonical identity to
   * dedup across snapshot/message events and across reconnects (each
   * reconnect re-emits a snapshot containing already-seen messages).
   */
  streamExecuteMessages(): Observable<
    | { type: 'snapshot'; data: IVeExecuteMessagesResponse }
    | { type: 'message'; data: { application: string; task: string; message: IVeExecuteMessage } }
  > {
    return new Observable(subscriber => {
      let eventSource: EventSource | null = null;
      let closed = false;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      // Start at 1s, double on each consecutive failure, cap at 30s.
      let backoffMs = 1000;

      const connect = (): void => {
        if (closed) return;
        let baseUrl: string;
        try { baseUrl = this.resolveVeContext(ApiUri.VeExecuteStream); }
        catch (err) { subscriber.error(err); return; }
        eventSource = new EventSource(baseUrl);

        eventSource.addEventListener('open', () => {
          // Successful open — reset backoff so the next failure starts at 1s.
          backoffMs = 1000;
        });

        eventSource.addEventListener('snapshot', (event: MessageEvent) => {
          try {
            const parsed = JSON.parse(event.data) as IVeExecuteMessagesResponse;
            subscriber.next({ type: 'snapshot', data: parsed });
          } catch { /* ignore parse errors */ }
        });

        eventSource.addEventListener('message', (event: MessageEvent) => {
          try {
            const parsed = JSON.parse(event.data) as { application: string; task: string; message: IVeExecuteMessage };
            subscriber.next({ type: 'message', data: parsed });
          } catch { /* ignore parse errors */ }
        });

        eventSource.onerror = () => {
          if (closed) return;
          if (eventSource && eventSource.readyState === EventSource.CLOSED) {
            // Server closed the stream (CT replaced, network blip, …).
            // Schedule reconnect rather than completing the Observable —
            // the consumer should keep observing the same task across CT
            // replacement (hostname/IP stay the same after the swap).
            eventSource.close();
            eventSource = null;
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              backoffMs = Math.min(backoffMs * 2, 30_000);
              connect();
            }, backoffMs);
          }
          // For non-CLOSED errors EventSource auto-reconnects internally; no action needed.
        };
      };

      connect();

      return () => {
        closed = true;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
      };
    });
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
    let url: string;
    try { url = this.resolveVeContext(ApiUri.FrameworkCreateApplication); }
    catch (err) { return throwError(() => err); }
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

  stackRestorePreview(body: IStackRestorePreviewRequest): Observable<IStackRestorePreviewResponse> {
    return this.http.post<IStackRestorePreviewResponse>(ApiUri.StackRestorePreview, body);
  }

  /**
   * Fetch refresh preview for a stack. Deliberately stateless: does NOT use
   * `veContextKey`. The backend picks the default VE context (current: true)
   * and returns its host in `veContextHost` so the UI can display it.
   */
  getStackRefreshPreview(
    stackId: string,
    opts?: { varName?: string; vmId?: number },
  ): Observable<{ preview: unknown; veContextHost: string }> {
    const url = ApiUri.StackRefreshPreview.replace(':id', encodeURIComponent(stackId));
    const body: Record<string, unknown> = {};
    if (opts?.varName !== undefined) body['varName'] = opts.varName;
    if (opts?.vmId !== undefined) body['vmId'] = opts.vmId;
    return this.http.post<{ preview: unknown; veContextHost: string }>(url, body);
  }

  /**
   * Dispatch the check-task for a specific container. Fire-and-forget use
   * case from the refresh-stack flow: after patching + pct restart we want
   * the app's check templates to run so post-restart health is visible in
   * the Process Monitor. Uses an explicit veContextKey (stateless) so it
   * does not clobber the sticky context used elsewhere.
   */
  dispatchCheckTask(
    application: string,
    veContextKey: string,
    vmId: number,
    hostname: string,
  ): Observable<{ success: boolean; restartKey?: string }> {
    const url = ApiUri.VeConfiguration
      .replace(':application', encodeURIComponent(application))
      .replace(':veContext', veContextKey);
    const body: IPostVeConfigurationBody = {
      task: 'check',
      params: [
        { name: 'vm_id', value: vmId },
        { name: 'hostname', value: hostname },
      ],
    };
    return this.http.post<{ success: boolean; restartKey?: string }>(url, body);
  }

  /**
   * Apply a stack refresh. Stateless — backend resolves the current VE context.
   */
  applyStackRefresh(
    stackId: string,
    varName: string,
    newValue: string,
    opts?: { oldValue?: string; vmId?: number },
  ): Observable<{ result: unknown; veContextHost: string }> {
    const url = ApiUri.StackRefreshApply.replace(':id', encodeURIComponent(stackId));
    const body: Record<string, unknown> = {
      varName,
      newValue,
      oldValue: opts?.oldValue ?? '',
    };
    if (opts?.vmId !== undefined) body['vmId'] = opts.vmId;
    return this.http.post<{ result: unknown; veContextHost: string }>(url, body);
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

  postDomainSuffix(suffix: string): Observable<{ success: boolean; project_domain_suffix: string }> {
    return this.post<{ success: boolean; project_domain_suffix: string }, object>(ApiUri.CertificateDomainSuffix, { project_domain_suffix: suffix });
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

  postGenerateClientCert(cn: string): Observable<IGenerateClientCertResponse> {
    return this.post<IGenerateClientCertResponse, IPostGenerateClientCertBody>(ApiUri.CertificateClientGenerate, { cn });
  }

  getAllCertificates(): Observable<ICertificateStatusResponse> {
    return this.get<ICertificateStatusResponse>(ApiUri.CertificatesAll);
  }

  getAutoRenewalStatus(): Observable<IAutoRenewalStatus> {
    return this.get<IAutoRenewalStatus>(ApiUri.CertificateAutoRenewal);
  }

  setAutoRenewalEnabled(enabled: boolean): Observable<IAutoRenewalStatus> {
    return this.post<IAutoRenewalStatus, { enabled: boolean }>(ApiUri.CertificateAutoRenewal, { enabled });
  }

  triggerAutoRenewalCheck(): Observable<IAutoRenewalStatus> {
    return this.post<IAutoRenewalStatus, object>(ApiUri.CertificateAutoRenewalCheck, {});
  }

  renewAllCertificates(hostnames?: string[]): Observable<IAutoRenewalStatus> {
    const body = hostnames && hostnames.length > 0 ? { hostnames } : {};
    return this.post<IAutoRenewalStatus, object>(ApiUri.CertificateRenewAll, body);
  }

  getLogRotationStatus(): Observable<ILogRotationStatus> {
    return this.get<ILogRotationStatus>(ApiUri.LogRotation);
  }

  setLogRotationEnabled(enabled: boolean): Observable<ILogRotationStatus> {
    return this.post<ILogRotationStatus, { enabled: boolean }>(ApiUri.LogRotation, { enabled });
  }

  triggerLogRotationCheck(): Observable<ILogRotationStatus> {
    return this.post<ILogRotationStatus, object>(ApiUri.LogRotationCheck, {});
  }

  getReplacedCleanupStatus(): Observable<IReplacedCleanupStatus> {
    return this.get<IReplacedCleanupStatus>(ApiUri.ReplacedCleanup);
  }

  setReplacedCleanupConfig(body: { enabled?: boolean; grace_days?: number }): Observable<IReplacedCleanupStatus> {
    return this.post<IReplacedCleanupStatus, typeof body>(ApiUri.ReplacedCleanup, body);
  }

  triggerReplacedCleanupRun(): Observable<IReplacedCleanupStatus> {
    return this.post<IReplacedCleanupStatus, object>(ApiUri.ReplacedCleanupRun, {});
  }

  listLockedContainers(): Observable<ILockedContainer[]> {
    return this.get<ILockedContainer[]>(ApiUri.LockedCleanupList);
  }

  destroyAllLockedContainers(): Observable<ILockedCleanupResult> {
    return this.post<ILockedCleanupResult, object>(ApiUri.LockedCleanupDestroy, {});
  }

  // Bulk-destroy the given containers in the active VE context (used by the
  // installations page to purge stopped/migrated debris). `post()` fills in the
  // :veContext placeholder from the currently selected host.
  destroyInstallations(vmIds: number[]): Observable<ILockedCleanupResult> {
    return this.post<ILockedCleanupResult, { vmIds: number[] }>(ApiUri.InstallationsDestroy, { vmIds });
  }

  checkDependencies(applicationId: string, addons?: string[], stackIds?: string[]): Observable<IDependencyCheckResponse> {
    let url = ApiUri.DependencyCheck.replace(':application', encodeURIComponent(applicationId));
    if (this.veContextKey) {
      url = url.replace(':veContext', this.veContextKey);
    }
    const params: string[] = [];
    if (addons && addons.length > 0) {
      params.push(`addons=${addons.map(a => encodeURIComponent(a)).join(',')}`);
    }
    if (stackIds && stackIds.length > 0) {
      params.push(`stackIds=${stackIds.map(s => encodeURIComponent(s)).join(',')}`);
    }
    if (params.length > 0) {
      url += '?' + params.join('&');
    }
    return this.http.get<IDependencyCheckResponse>(url);
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
