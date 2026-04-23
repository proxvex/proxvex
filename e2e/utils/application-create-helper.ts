import { Page, expect } from '@playwright/test';
import { E2EApplication, UploadFile } from './application-loader';
import { SSHValidator } from './ssh-validator';
import { getPveHost, getLocalPath, getSshPort } from '../fixtures/test-base';
import { readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SSH_PORT = getSshPort();

/**
 * Page Object for application creation via UI wizard.
 *
 * Encapsulates the navigation logic for:
 * - Creating new applications via the create-application wizard
 * - Cleanup and validation of created applications (local or SSH-based)
 *
 * In local mode (localPath configured), file operations use the local filesystem.
 * In remote mode, operations use SSH to the PVE host.
 *
 * @example
 * ```typescript
 * const helper = new ApplicationCreateHelper(page);
 * await helper.cleanupApplicationOnHost('my-app');
 * await helper.createApplication(app);
 * await helper.validateApplicationFilesOnHost('my-app');
 * ```
 */
export class ApplicationCreateHelper {
  private sshValidator: SSHValidator;
  private remoteAppBasePath = '/root/proxvex/json/applications';
  private localPath: string | undefined;

  constructor(private page: Page) {
    this.localPath = getLocalPath();
    this.sshValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
    });
  }

  /**
   * Get the applications base path (local or remote)
   */
  private getAppBasePath(): string {
    if (this.localPath) {
      // Resolve relative to project root
      return resolve(process.cwd(), this.localPath, 'applications');
    }
    return this.remoteAppBasePath;
  }

  /**
   * Delete existing application directory before test.
   * Uses local fs operations in local mode, SSH otherwise.
   * This ensures a clean state for creating a new application.
   */
  cleanupApplicationOnHost(applicationId: string): { success: boolean; message: string } {
    const appPath = `${this.getAppBasePath()}/${applicationId}`;

    if (this.localPath) {
      // Local mode: use fs operations
      try {
        if (existsSync(appPath)) {
          rmSync(appPath, { recursive: true, force: true });
          console.log(`Cleanup (local): Deleted ${appPath}`);
          return { success: true, message: `Directory ${appPath} deleted locally` };
        }
        console.log(`Cleanup (local): ${appPath} does not exist`);
        return { success: true, message: `Directory ${appPath} did not exist` };
      } catch (error) {
        console.error(`Cleanup (local) failed: ${error}`);
        return { success: false, message: `Failed to delete ${appPath}: ${error}` };
      }
    }

    // Remote mode: use SSH
    const result = this.sshValidator.deleteDirectoryOnHost(appPath);
    console.log(`Cleanup (SSH): ${result.message}`);
    return result;
  }

  /**
   * Validate that application files were created.
   * Uses local fs in local mode, SSH otherwise.
   * Checks for application.json and optionally template.json.
   */
  validateApplicationFilesOnHost(
    applicationId: string,
    hasUploadFiles: boolean = false
  ): { success: boolean; errors: string[] } {
    const appPath = `${this.getAppBasePath()}/${applicationId}`;
    const errors: string[] = [];

    if (this.localPath) {
      // Local mode: use fs operations
      const appJsonPath = join(appPath, 'application.json');
      if (existsSync(appJsonPath)) {
        console.log(`Application JSON check (local): File exists at ${appJsonPath}`);
      } else {
        const msg = `File ${appJsonPath} does not exist`;
        console.log(`Application JSON check (local): ${msg}`);
        errors.push(msg);
      }

      if (hasUploadFiles) {
        const templateJsonPath = join(appPath, 'template.json');
        if (existsSync(templateJsonPath)) {
          console.log(`Template JSON check (local): File exists at ${templateJsonPath}`);
        } else {
          const msg = `File ${templateJsonPath} does not exist`;
          console.log(`Template JSON check (local): ${msg}`);
          errors.push(msg);
        }
      }
    } else {
      // Remote mode: use SSH
      const appJsonCheck = this.sshValidator.validateFileOnHost({
        path: `${appPath}/application.json`,
      });
      console.log(`Application JSON check (SSH): ${appJsonCheck.message}`);
      if (!appJsonCheck.success) {
        errors.push(appJsonCheck.message);
      }

      if (hasUploadFiles) {
        const templateJsonCheck = this.sshValidator.validateFileOnHost({
          path: `${appPath}/template.json`,
        });
        console.log(`Template JSON check (SSH): ${templateJsonCheck.message}`);
        if (!templateJsonCheck.success) {
          errors.push(templateJsonCheck.message);
        }
      }
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }

  /**
   * Navigate to create application page
   */
  async goToCreateApplication(): Promise<void> {
    const response = await this.page.goto('/create-application');
    console.log('Navigated to:', this.page.url());
    console.log('Response status:', response?.status());

    // Wait for Angular to fully load
    await this.page.waitForLoadState('domcontentloaded');

    // Step 1: Wait for framework select to be visible
    const frameworkSelect = this.page.locator('[data-testid="framework-select"]');
    await frameworkSelect.waitFor({ state: 'visible', timeout: 15000 });
    console.log('Framework select visible');

    // Step 2: Wait for frameworks to be loaded by checking if select has a value
    await this.page.waitForFunction(() => {
      const select = document.querySelector('[data-testid="framework-select"]');
      const valueText = select?.querySelector('.mat-mdc-select-value-text');
      return valueText && valueText.textContent && valueText.textContent.includes('oci-image');
    }, { timeout: 15000 });
    console.log('Framework oci-image is selected');

    // Step 3: Wait for compose file input
    await this.page.locator('#compose-file-input').waitFor({ state: 'attached', timeout: 15000 });
    console.log('Compose file input is attached');
  }

  /**
   * Select a framework in step 1
   */
  async selectFramework(frameworkId: string): Promise<void> {
    const frameworkSelect = this.page.locator('[data-testid="framework-select"]');
    await frameworkSelect.click();

    const option = this.page.locator(`mat-option:has-text("${frameworkId}")`);
    await option.waitFor({ state: 'visible' });
    await option.click();

    await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  /**
   * Upload docker-compose file
   */
  async uploadDockerCompose(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="docker-compose-upload"]').or(
      this.page.locator('#compose-file-input')
    );
    await fileInput.setInputFiles(filePath);

    await this.page.locator('mat-hint:has-text("Services:"), mat-error').first().waitFor({
      state: 'visible',
      timeout: 10000
    }).catch(() => {});
  }

  /**
   * Upload .env file (optional)
   */
  async uploadEnvFile(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="env-file-upload"]').or(
      this.page.locator('#env-file-input')
    );
    await fileInput.setInputFiles(filePath);
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Upload icon file
   */
  async uploadIcon(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="icon-upload"]').or(
      this.page.locator('app-icon-upload input[type="file"]')
    );
    await fileInput.setInputFiles(filePath);

    await this.page.locator('app-icon-upload img, app-icon-upload .icon-preview').first().waitFor({
      state: 'visible',
      timeout: 5000
    }).catch(() => {});
  }

  /**
   * Fill application properties form
   * @param name - Display name for the application
   * @param description - Optional description
   * @param applicationId - Optional explicit application ID (if not set, uses current value or generates from name)
   */
  async fillAppProperties(name: string, description?: string, applicationId?: string): Promise<void> {
    const nameInput = this.page.locator('[data-testid="app-name-input"]').or(
      this.page.locator('input[formControlName="name"]')
    );
    await nameInput.waitFor({ state: 'visible' });
    await nameInput.fill(name);

    const appIdInput = this.page.locator('input[formControlName="applicationId"]');
    await appIdInput.waitFor({ state: 'visible' });

    // Use explicit applicationId if provided, otherwise keep UI-generated value or generate from name
    if (applicationId) {
      await appIdInput.fill(applicationId);
    } else {
      const currentValue = await appIdInput.inputValue();
      if (!currentValue || currentValue.trim() === '') {
        const appId = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        await appIdInput.fill(appId);
      }
    }

    const descInput = this.page.locator('[data-testid="app-description-input"]').or(
      this.page.locator('textarea[formControlName="description"]')
    );

    if (description) {
      await descInput.fill(description);
    } else {
      // Wait for description to be auto-filled from OCI image annotations
      await expect(async () => {
        const value = await descInput.inputValue();
        expect(value.trim().length).toBeGreaterThan(0);
      }).toPass({ timeout: 15000 });
    }
  }

  /**
   * Select stacktype in the stacktype dropdown
   */
  async selectStacktype(stacktype: string): Promise<void> {
    // Find the mat-form-field containing "Stacktype" label
    const stacktypeFormField = this.page.locator('mat-form-field:has(mat-label:has-text("Stacktype"))');

    // Wait for it to appear (stacktypes loaded from backend)
    try {
      await stacktypeFormField.waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      console.warn('Stacktype dropdown not visible - stacktypes may not be loaded');
      return;
    }

    // Click the mat-select inside
    const select = stacktypeFormField.locator('mat-select');
    await select.click();

    // Wait for options panel
    await this.page.locator('.mat-mdc-select-panel, .mat-select-panel').waitFor({ state: 'visible', timeout: 5000 });

    // Click the matching option
    const option = this.page.locator(`mat-option:has-text("${stacktype}")`);
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();

    // Wait for panel to close
    await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    console.log(`Selected stacktype: ${stacktype}`);
  }

  /**
   * Select stack from stack-selector if available in summary step.
   * Selects the first available stack (usually "default" which has auto-generated passwords).
   * @param expectStack - If true, waits longer for the stack selector to appear (stacks API may still be loading)
   */
  async selectStackIfAvailable(expectStack = false): Promise<void> {
    const summaryStep = this.page.locator('app-summary-step');
    const stackSelector = summaryStep.locator('.secrets-selector app-stack-selector');

    // Wait for stack selector to appear.
    // When expectStack is true, the stacks API may still be loading so we wait longer.
    // When false, we do a quick check to avoid wasting time on apps without stacktype.
    const timeout = expectStack ? 10000 : 1000;
    try {
      await stackSelector.waitFor({ state: 'visible', timeout });
    } catch {
      console.log('Stack selector not visible - skipping stack selection');
      return;
    }

    // Find and click the mat-select inside
    const select = stackSelector.locator('mat-select');
    if (await select.count() === 0) {
      console.warn('Stack selector has no mat-select');
      return;
    }

    await select.click();

    // Wait for options panel
    await this.page.locator('.mat-mdc-select-panel, .mat-select-panel').waitFor({ state: 'visible', timeout: 5000 });

    // Select first option (usually "default")
    const firstOption = this.page.locator('mat-option').first();
    await firstOption.waitFor({ state: 'visible', timeout: 5000 });
    const optionText = await firstOption.textContent();
    await firstOption.click();

    // Wait for panel to close
    await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    console.log(`Selected stack: ${optionText?.trim()}`);
  }

  /**
   * Select tags in the tags selector
   */
  async selectTags(tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) return;

    const tagsSection = this.page.locator('app-tags-selector');
    await tagsSection.waitFor({ state: 'visible', timeout: 10000 });

    for (const tag of tags) {
      const chipOption = this.page.locator(`mat-chip-option:has-text("${tag}")`);
      if (await chipOption.count() > 0) {
        await chipOption.click();
        await this.page.waitForTimeout(100);
      } else {
        console.warn(`Tag "${tag}" not found in tags selector`);
      }
    }
  }

  /**
   * Configure upload files in the Upload Files step
   */
  async configureUploadFiles(uploadfiles: UploadFile[]): Promise<void> {
    const uploadFilesStep = this.page.locator('[data-testid="upload-files-step"]');
    await uploadFilesStep.waitFor({ state: 'visible', timeout: 10000 });

    for (const file of uploadfiles) {
      // Click "Add file" button to open the input fields
      await this.page.locator('[data-testid="add-row-btn"]').click();
      await this.page.locator('[data-testid="new-key-input"]').waitFor({ state: 'visible', timeout: 5000 });

      // Fill in the fields: key = destination, value = label (optional)
      await this.page.locator('[data-testid="new-key-input"]').fill(file.destination);
      if (file.label) {
        await this.page.locator('[data-testid="new-value-input"]').fill(file.label);
      }

      // Click confirm button to add the entry
      await this.page.locator('[data-testid="confirm-add-btn"]').click();
      await this.page.waitForTimeout(100);
    }
  }

  /**
   * Click Next button to proceed to next step
   */
  async clickNext(): Promise<void> {
    const nextBtn = this.page.locator('[data-testid="next-step-btn"]:visible');
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
    await nextBtn.scrollIntoViewIfNeeded();
    await nextBtn.click();
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Click Save Application button in summary step (saves without installing)
   */
  async clickSave(): Promise<void> {
    const saveBtn = this.page.locator('[data-testid="save-application-btn"]:visible');
    await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await saveBtn.click();
  }

  /**
   * Click Save & Install button in summary step (saves and starts installation)
   */
  async clickSaveAndInstall(): Promise<void> {
    const saveAndInstallBtn = this.page.locator('[data-testid="save-and-install-btn"]:visible');
    await saveAndInstallBtn.waitFor({ state: 'visible', timeout: 10000 });
    await saveAndInstallBtn.click();
  }

  /**
   * Wait for install parameters to load in the summary step.
   * The summary step loads parameters asynchronously when entered.
   */
  async waitForInstallParametersLoaded(): Promise<void> {
    // Wait for loading spinner to disappear or info message to appear
    const loadingSpinner = this.page.locator('app-summary-step mat-spinner');
    const infoMessage = this.page.locator('app-summary-step .info-container');
    const parameterGroups = this.page.locator('app-summary-step app-parameter-group');

    // Wait for either: parameters loaded, info message (no params needed), or timeout
    await Promise.race([
      loadingSpinner.waitFor({ state: 'hidden', timeout: 15000 }),
      infoMessage.waitFor({ state: 'visible', timeout: 15000 }),
      parameterGroups.first().waitFor({ state: 'visible', timeout: 15000 }),
    ]).catch(() => {});

    // Give a moment for the form to initialize
    await this.page.waitForTimeout(500);
  }

  /**
   * Auto-fill required dropdowns and select stack in the summary step's install parameters.
   * Similar to autoFillRequiredDropdowns in ApplicationInstallHelper but for the summary step.
   * @param hasStacktype - If true, expects a stack selector and waits for stacks to load
   */
  async autoFillInstallParameters(hasStacktype = false): Promise<void> {
    const summaryStep = this.page.locator('app-summary-step');

    // Select stack if stack-selector is present (for applications with stacktype)
    // The stack provides values like POSTGRES_PASSWORD
    await this.selectStackIfAvailable(hasStacktype);

    // Handle app-enum-select components (custom dropdown wrapper)
    const enumSelects = summaryStep.locator('app-enum-select');
    const enumCount = await enumSelects.count();

    for (let i = 0; i < enumCount; i++) {
      const enumSelect = enumSelects.nth(i);
      const label = await enumSelect.locator('..').locator('[class*="label"], label').first().textContent().catch(() => '');
      const isRequired = label?.includes('*') ?? false;

      if (isRequired) {
        const combobox = enumSelect.locator('[role="combobox"], mat-select');
        if (await combobox.count() > 0) {
          const hasValue = await combobox.locator('.mat-mdc-select-value-text, .mat-select-value-text').count() > 0;

          if (!hasValue) {
            await combobox.click();
            await this.page.locator('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').waitFor({
              state: 'visible',
              timeout: 5000
            });
            const firstOption = this.page.locator('mat-option').first();
            await firstOption.waitFor({ state: 'visible', timeout: 5000 });
            await firstOption.click();
            await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
          }
        }
      }
    }

    // Handle standard mat-select with required attribute
    const matSelects = summaryStep.locator('mat-select[required], mat-select[ng-reflect-required="true"]');
    const selectCount = await matSelects.count();

    for (let i = 0; i < selectCount; i++) {
      const select = matSelects.nth(i);
      const hasValue = await select.locator('.mat-mdc-select-value-text, .mat-select-value-text').count() > 0;

      if (!hasValue) {
        await select.click();
        await this.page.locator('.mat-mdc-select-panel, .mat-select-panel').waitFor({ state: 'visible', timeout: 5000 });
        const firstOption = this.page.locator('mat-option').first();
        await firstOption.waitFor({ state: 'visible', timeout: 5000 });
        await firstOption.click();
        await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }
    }
  }

  /**
   * Show advanced parameters in the summary step if the toggle is available.
   */
  async showAdvancedParametersIfNeeded(): Promise<void> {
    const summaryStep = this.page.locator('app-summary-step');
    const advancedToggle = summaryStep.locator('button:has-text("Show Advanced Parameters")');

    try {
      await advancedToggle.waitFor({ state: 'visible', timeout: 3000 });
      await advancedToggle.click();
      console.log('Showed advanced parameters');
      await this.page.waitForTimeout(300);
    } catch {
      console.log('No advanced parameters toggle found - skipping');
    }
  }

  /**
   * Apply install parameters by finding inputs via their mat-label in the mat-form-field.
   * Angular's [formControlName] directive does not render as a DOM attribute,
   * so we locate fields by their visible label text instead.
   */
  async applyInstallParams(params: Record<string, string>): Promise<void> {
    const summaryStep = this.page.locator('app-summary-step');

    for (const [paramId, value] of Object.entries(params)) {
      // Find mat-form-field by its mat-label text (exact match first, then substring)
      let formField = summaryStep.locator(`mat-form-field:has(mat-label:text-is("${paramId}"))`);
      if (await formField.count() === 0) {
        formField = summaryStep.locator(`mat-form-field:has(mat-label:has-text("${paramId}"))`);
      }

      if (await formField.count() === 0) {
        console.warn(`Install param ${paramId}: no matching mat-form-field found`);
        continue;
      }

      // Try input
      const input = formField.first().locator('input');
      if (await input.count() > 0) {
        await input.fill(value);
        console.log(`Set install param ${paramId} = ${value}`);
        continue;
      }

      // Try textarea
      const textarea = formField.first().locator('textarea');
      if (await textarea.count() > 0) {
        await textarea.fill(value);
        console.log(`Set install param ${paramId} = ${value}`);
        continue;
      }

      // Try mat-select
      const select = formField.first().locator('mat-select');
      if (await select.count() > 0) {
        await select.click();
        const option = this.page.locator(`mat-option:has-text("${value}")`);
        await option.waitFor({ state: 'visible', timeout: 5000 });
        await option.click();
        await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        console.log(`Set install param ${paramId} = ${value} (select)`);
        continue;
      }

      console.warn(`Install param ${paramId}: no input/textarea/select in form field`);
    }
  }

  /**
   * Validate that all configured upload files are displayed in the summary step.
   * Each upload file should have its own entry in the summary.
   * @throws Error if expected upload files are not found or count doesn't match
   */
  async validateUploadFilesInSummary(expectedFiles: UploadFile[]): Promise<void> {
    if (!expectedFiles || expectedFiles.length === 0) {
      console.log('No upload files to validate in summary');
      return;
    }

    // Switch to Application Data tab to see upload files
    const appDataTab = this.page.locator('mat-tab-header .mdc-tab:has-text("Application Data")');
    await appDataTab.click();
    await this.page.waitForTimeout(300);

    // Wait for upload files section
    const uploadFilesCard = this.page.locator('[data-testid="summary-upload-files"]');
    await uploadFilesCard.waitFor({ state: 'visible', timeout: 10000 });

    // Count upload file entries
    const uploadFileEntries = this.page.locator('[data-testid^="summary-upload-file-"]');
    const actualCount = await uploadFileEntries.count();

    if (actualCount !== expectedFiles.length) {
      throw new Error(
        `Upload files count mismatch in summary: expected ${expectedFiles.length}, found ${actualCount}. ` +
        `This may indicate duplicate template names.`
      );
    }

    // Validate each expected file is present
    for (let i = 0; i < expectedFiles.length; i++) {
      const file = expectedFiles[i];
      // Get expected label: explicit label or basename from destination
      const expectedLabel = file.label || this.getFilenameFromDestination(file.destination);
      const entry = this.page.locator(`[data-testid="summary-upload-file-${i}"]`);
      const entryText = await entry.textContent();

      if (!entryText?.includes(expectedLabel)) {
        throw new Error(
          `Upload file "${expectedLabel}" not found at position ${i} in summary. ` +
          `Found: "${entryText}"`
        );
      }
      console.log(`✓ Upload file ${i}: ${expectedLabel}`);
    }

    console.log(`Validated ${actualCount} upload files in summary`);

    // Switch back to Install Parameters tab so waitForInstallParametersLoaded() works correctly.
    // If we stay on Application Data tab, the loading spinner is hidden (wrong tab) and
    // waitForInstallParametersLoaded() resolves immediately before parameters are actually loaded.
    const installParamsTab = this.page.locator('mat-tab-header .mdc-tab:has-text("Install Parameters")');
    await installParamsTab.click();
    await this.page.waitForTimeout(300);
  }

  /**
   * Create a new application via the create-application wizard.
   *
   * Steps:
   * 1. Navigate to /create-application
   * 2. Select docker-compose framework
   * 3. Upload docker-compose file
   * 4. Fill app properties (name, description)
   * 5. Upload icon (optional)
   * 6. Navigate through parameters step
   * 7. Save application (optionally with installation)
   *
   * @param app - The application configuration
   * @param options - Optional settings
   * @param options.installAfterSave - If true, clicks "Save & Install" and navigates to monitor page
   */
  async createApplication(
    app: E2EApplication,
    options: { installAfterSave?: boolean } = {}
  ): Promise<void> {
    const { installAfterSave = false } = options;

    await this.goToCreateApplication();

    // Select framework if not the default oci-image
    if (app.framework && app.framework !== 'oci-image') {
      await this.selectFramework(app.framework);
    }

    if (app.dockerCompose) {
      await this.uploadDockerCompose(app.dockerCompose);
    }

    if (app.envFile) {
      await this.uploadEnvFile(app.envFile);
    }

    await this.clickNext();

    await this.fillAppProperties(app.name, app.description, app.applicationId);

    if (app.tags && app.tags.length > 0) {
      await this.selectTags(app.tags);
    }

    // Select stacktype if defined (e.g., 'postgres' for applications needing a database stack)
    if (app.tasktype && app.tasktype !== 'default') {
      await this.selectStacktype(app.tasktype);
    }

    if (app.icon) {
      await this.uploadIcon(app.icon);
    }

    await this.clickNext();

    await this.page.waitForLoadState('networkidle');
    await this.clickNext();

    if (app.uploadfiles && app.uploadfiles.length > 0) {
      await this.configureUploadFiles(app.uploadfiles);
    }
    await this.clickNext();

    // Validate upload files are correctly displayed in summary
    if (app.uploadfiles && app.uploadfiles.length > 0) {
      await this.validateUploadFilesInSummary(app.uploadfiles);
    }

    if (installAfterSave) {
      // Wait for install parameters to load in summary step
      await this.waitForInstallParametersLoaded();

      // Upload files for upload parameters (e.g., mosquitto.conf)
      if (app.uploadfiles && app.uploadfiles.length > 0) {
        await this.uploadFilesForParameters(app.uploadfiles, app.directory);
      }

      // Auto-fill required dropdowns (like PVE host selection) and select stack FIRST.
      // Stack selection fills in default values (e.g., passwords).
      const hasStacktype = !!app.tasktype && app.tasktype !== 'default';
      await this.autoFillInstallParameters(hasStacktype);

      // THEN show advanced parameters and apply install params to override specific values.
      // This must happen after stack selection, otherwise the stack resets form values.
      if (app.installParams && Object.keys(app.installParams).length > 0) {
        await this.showAdvancedParametersIfNeeded();
        await this.applyInstallParams(app.installParams);
      }

      await this.clickSaveAndInstall();
      // When using Save & Install, we navigate to /monitor
      await expect(this.page).toHaveURL(/\/monitor/, { timeout: 30000 });
    } else {
      // Listen for the browser alert() before clicking Save
      this.page.once('dialog', dialog => dialog.accept());
      await this.clickSave();
      // After alert is accepted, the app navigates to /applications
      await expect(this.page).toHaveURL(/\/applications/, { timeout: 15000 });
    }
  }

  /**
   * Upload files for upload parameters in the summary step.
   * Finds file inputs by parameter ID and uploads the corresponding file.
   */
  async uploadFilesForParameters(uploadfiles: UploadFile[], appDirectory: string): Promise<void> {
    for (const uploadFile of uploadfiles) {
      if (!uploadFile.file) continue;

      const filePath = join(appDirectory, uploadFile.file);
      if (!existsSync(filePath)) {
        console.warn(`Upload file not found: ${filePath}`);
        continue;
      }

      // Derive paramId from destination (same logic as backend frameworkloader.mts:sanitizeFilename)
      const paramId = this.getUploadParamId(uploadFile.destination);
      const fileInputId = `file-${paramId}`;

      const fileInput = this.page.locator(`#${fileInputId}`);
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(filePath);
        console.log(`Uploaded ${uploadFile.file} → ${paramId}`);
        await this.page.waitForTimeout(300);
      } else {
        console.warn(`File input #${fileInputId} not found`);
      }
    }
  }

  /**
   * Derive upload parameter ID from destination.
   * Matches backend logic in frameworkloader.mts:sanitizeFilename()
   */
  private getUploadParamId(destination: string): string {
    const colonIndex = destination.indexOf(':');
    const filePath = colonIndex >= 0 ? destination.slice(colonIndex + 1) : destination;
    const filename = basename(filePath);
    const sanitized = filename.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `upload_${sanitized.replace(/-/g, '_')}_content`;
  }

  /**
   * Extract filename from destination path (e.g., "config:certs/server.crt" -> "server.crt")
   */
  private getFilenameFromDestination(destination: string): string {
    const colonIndex = destination.indexOf(':');
    const filePath = colonIndex >= 0 ? destination.slice(colonIndex + 1) : destination;
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  }
}
