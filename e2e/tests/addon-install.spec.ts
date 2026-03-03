import { test, expect, getPveHost, getSshPort, getDeployerStaticIp } from '../fixtures/test-base';
import { E2EApplicationLoader, E2EApplication } from '../utils/application-loader';
import { SSHValidator } from '../utils/ssh-validator';
import { ApplicationInstallHelper } from '../utils/application-install-helper';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { Page } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Addon Installation E2E Tests
 *
 * These tests verify the flow of:
 * 1. Creating a base application via wizard
 * 2. Installing it with an addon
 * 3. Validating the addon installation via SSH
 *
 * Prerequisites:
 * - Proxmox VM running (step1-create-vm.sh)
 * - Deployer container installed (step2-install-deployer.sh)
 * - Angular dev server running
 */

const SSH_PORT = getSshPort();

// Addon test configuration
interface AddonTestConfig {
  name: string;
  description: string;
  baseApplication: string;
  addon: string;
  addonParams: Record<string, string>;
  addonFiles?: Record<string, string>;
  validation: {
    waitBeforeValidation?: number;
    processes?: Array<{ name: string; description?: string }>;
    ports?: Array<{ port: number; protocol?: string; service?: string }>;
    files?: Array<{ path: string; contentPattern?: string }>;
    commands?: Array<{ command: string; expectedOutput?: string; description?: string }>;
  };
}

/**
 * Load addon test configuration from appconf.json
 */
function loadAddonConfig(addonName: string): AddonTestConfig {
  const addonConfigPath = join(__dirname, '..', 'applications', addonName, 'appconf.json');
  if (!existsSync(addonConfigPath)) {
    throw new Error(`Addon config not found: ${addonConfigPath}`);
  }
  return JSON.parse(readFileSync(addonConfigPath, 'utf-8'));
}

/**
 * Select an addon by name in the configuration dialog.
 * Finds the checkbox matching the addon display name and clicks it.
 */
async function selectAddon(page: Page, addonDisplayName: string): Promise<void> {
  const addonSection = page.locator('app-addon-section');
  await expect(addonSection).toBeVisible({ timeout: 15000 });
  console.log('Addon section visible');

  // Find and click the addon checkbox by display name
  const addonCheckbox = page.locator('mat-checkbox').filter({
    hasText: new RegExp(addonDisplayName, 'i')
  }).first();
  await expect(addonCheckbox).toBeVisible({ timeout: 10000 });
  await addonCheckbox.click();
  console.log(`${addonDisplayName} addon clicked`);

  // Confirm the addon notice dialog (if present)
  const noticeDialog = page.locator('app-addon-notice-dialog');
  if (await noticeDialog.isVisible({ timeout: 3000 }).catch(() => false)) {
    const okButton = noticeDialog.locator('button:has-text("OK")');
    await okButton.click();
    console.log('Addon notice dialog confirmed');
    await page.waitForTimeout(500);
  }
  console.log(`${addonDisplayName} addon selected`);
}

/**
 * Fill addon parameters generically based on addonParams config.
 * Matches input fields by their mat-label text against parameter names.
 */
async function fillAddonParams(
  page: Page,
  addonParams: Record<string, string>,
  addonConfigName: string,
): Promise<void> {
  await page.waitForTimeout(500);

  const allInputs = page.locator('mat-form-field input');
  const inputCount = await allInputs.count();
  console.log(`Found ${inputCount} input fields for addon params`);

  // Build a map of label -> input for all visible form fields
  const labelInputMap: Map<string, ReturnType<typeof allInputs.nth>> = new Map();
  for (let i = 0; i < inputCount; i++) {
    const input = allInputs.nth(i);
    const formField = input.locator('xpath=ancestor::mat-form-field');
    const label = await formField.locator('mat-label').textContent().catch(() => '');
    if (label) {
      labelInputMap.set(label.trim().toLowerCase(), input);
    }
  }

  // Also check for mat-select dropdowns
  const allSelects = page.locator('mat-form-field mat-select');
  const selectCount = await allSelects.count();
  const labelSelectMap: Map<string, ReturnType<typeof allSelects.nth>> = new Map();
  for (let i = 0; i < selectCount; i++) {
    const select = allSelects.nth(i);
    const formField = select.locator('xpath=ancestor::mat-form-field');
    const label = await formField.locator('mat-label').textContent().catch(() => '');
    if (label) {
      labelSelectMap.set(label.trim().toLowerCase(), select);
    }
  }

  // Fill each addon parameter
  for (const [paramId, paramValue] of Object.entries(addonParams)) {
    let filled = false;

    // Try to find input by label containing the param name
    for (const [label, input] of labelInputMap) {
      const paramName = paramId.replace(/^.*\./, '').replace(/_/g, ' ');
      if (label.includes(paramName.toLowerCase())) {
        await input.fill(paramValue);
        console.log(`Filled ${paramId}: ${paramId.includes('password') ? '***' : paramValue}`);
        filled = true;
        break;
      }
    }

    // Try mat-select for enum params (like ssl.mode)
    if (!filled) {
      for (const [label, select] of labelSelectMap) {
        const paramName = paramId.replace(/^.*\./, '').replace(/_/g, ' ');
        if (label.includes(paramName.toLowerCase())) {
          await select.click();
          await page.waitForTimeout(300);
          const option = page.locator('mat-option').filter({ hasText: new RegExp(paramValue, 'i') }).first();
          if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
            await option.click();
            console.log(`Selected ${paramId}: ${paramValue}`);
            filled = true;
          } else {
            // Close dropdown if option not found
            await page.keyboard.press('Escape');
          }
          break;
        }
      }
    }

    if (!filled) {
      console.log(`Warning: Could not find input for addon param "${paramId}" in ${addonConfigName}`);
    }
  }
}

/**
 * Upload addon files if specified in the config.
 */
async function uploadAddonFiles(
  page: Page,
  addonFiles: Record<string, string> | undefined,
  addonConfigDir: string,
): Promise<void> {
  if (!addonFiles) return;

  for (const [_paramId, fileName] of Object.entries(addonFiles)) {
    const filePath = join(addonConfigDir, fileName);
    if (!existsSync(filePath)) {
      console.log(`Warning: addon file not found: ${filePath}`);
      continue;
    }

    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(filePath);
      console.log(`Uploaded ${fileName}`);
    }
  }
}

/**
 * Run addon validation via SSH and return results.
 */
async function validateAddon(
  page: Page,
  addonConfig: AddonTestConfig,
  createdVmId: string,
): Promise<void> {
  const appValidator = new SSHValidator({
    sshHost: getPveHost(),
    sshPort: SSH_PORT,
    containerVmId: createdVmId,
  });

  // Wait before validation
  if (addonConfig.validation.waitBeforeValidation) {
    console.log(`Waiting ${addonConfig.validation.waitBeforeValidation}s before validation...`);
    await page.waitForTimeout(addonConfig.validation.waitBeforeValidation * 1000);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Addon Validation for: ${addonConfig.name} (container ${createdVmId})`);
  console.log(`${'='.repeat(60)}`);

  const results: Array<{ success: boolean; message: string; details?: string }> = [];

  // Validate processes
  if (addonConfig.validation.processes) {
    for (const proc of addonConfig.validation.processes) {
      try {
        appValidator.execInContainer(`pgrep -x ${proc.name} || pgrep ${proc.name}`);
        results.push({ success: true, message: `Process ${proc.name} is running` });
      } catch {
        results.push({ success: false, message: `Process ${proc.name} is NOT running`, details: proc.description });
      }
    }
  }

  // Validate ports
  if (addonConfig.validation.ports) {
    for (const port of addonConfig.validation.ports) {
      try {
        const output = appValidator.execInContainer(`netstat -tlnp | grep :${port.port}`);
        results.push({
          success: output.includes(`:${port.port}`),
          message: `Port ${port.port} (${port.service || 'unknown'}) is listening`,
        });
      } catch {
        results.push({
          success: false,
          message: `Port ${port.port} (${port.service || 'unknown'}) is NOT listening`,
        });
      }
    }
  }

  // Validate files
  if (addonConfig.validation.files) {
    for (const file of addonConfig.validation.files) {
      try {
        const output = appValidator.execInContainer(`cat "${file.path}"`);
        const patternMatch = file.contentPattern ? new RegExp(file.contentPattern).test(output) : true;
        results.push({
          success: patternMatch,
          message: `File ${file.path} exists${file.contentPattern ? ' and matches pattern' : ''}`,
        });
      } catch {
        results.push({ success: false, message: `File ${file.path} does NOT exist` });
      }
    }
  }

  // Validate commands
  if (addonConfig.validation.commands) {
    for (const cmd of addonConfig.validation.commands) {
      try {
        const output = appValidator.execInContainer(cmd.command);
        const outputMatch = cmd.expectedOutput ? output.includes(cmd.expectedOutput) : true;
        results.push({
          success: outputMatch,
          message: cmd.description || `Command "${cmd.command}" succeeded`,
          details: output.substring(0, 200),
        });
      } catch (error) {
        results.push({
          success: false,
          message: cmd.description || `Command "${cmd.command}" failed`,
          details: String(error),
        });
      }
    }
  }

  // Log results
  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (passed.length > 0) {
    console.log(`\nPassed (${passed.length}):`);
    for (const result of passed) {
      console.log(`  + ${result.message}`);
    }
  }

  if (failed.length > 0) {
    console.log(`\nFailed (${failed.length}):`);
    for (const result of failed) {
      console.log(`  - ${result.message}`);
      if (result.details) {
        console.log(`    Details: ${result.details}`);
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary: ${passed.length}/${results.length} addon validations passed`);
  console.log(`${'─'.repeat(60)}\n`);

  const failedDetails = failed.map((r) => `- ${r.message}${r.details ? ` (${r.details})` : ''}`).join('\n');
  expect(failed.length, `${failed.length} of ${results.length} addon validations failed:\n${failedDetails}`).toBe(0);
}

/**
 * Get the display name for an addon to find its checkbox.
 * Maps addon IDs to their display names as shown in the UI.
 */
function getAddonDisplayName(addonId: string): string {
  const displayNames: Record<string, string> = {
    'samba-shares': 'Samba',
    'addon-ssl': 'SSL',
  };
  return displayNames[addonId] || addonId;
}

const loader = new E2EApplicationLoader(join(__dirname, '../applications'));

test.describe('Addon Installation E2E Tests', () => {
  let applications: E2EApplication[];

  test.beforeAll(async () => {
    applications = await loader.loadAll();
    console.log(`Loaded ${applications.length} test applications`);
  });

  test('install oci-lxc-deployer with ssl addon', async ({ page }) => {
    const addonConfig = loadAddonConfig('ssl-addon');
    console.log(`Testing addon: ${addonConfig.addon} on base application: ${addonConfig.baseApplication}`);

    const app = applications.find((a) => a.name === addonConfig.baseApplication);
    expect(app, `Base application ${addonConfig.baseApplication} should exist`).toBeDefined();

    const helper = new ApplicationInstallHelper(page);

    // Cleanup existing application
    console.log(`Cleaning up existing application: ${app!.applicationId}`);
    const cleanup = helper.cleanupApplication(app!.applicationId);
    console.log(`Cleanup result: ${cleanup.message}`);

    // Create the base application via wizard (Save only, no install yet)
    console.log(`Creating application: ${app!.name}`);
    await helper.createApplication(app!, { installAfterSave: false });
    console.log(`Application created: ${app!.name}`);

    // Navigate to Applications page
    await page.goto('/applications');
    await page.waitForLoadState('networkidle');
    console.log('Navigated to Applications page');

    // Find the created application card and click Install
    const appCard = page.locator('.card').filter({
      has: page.locator(`h2:text-is("${app!.name}"), h2:text-is("${app!.applicationId}")`)
    }).first();

    let foundCard = await appCard.count() > 0;
    if (!foundCard) {
      console.log('Card not found by exact match, trying partial match...');
      const cards = page.locator('.card');
      const count = await cards.count();
      for (let i = 0; i < count; i++) {
        const cardText = await cards.nth(i).textContent();
        if (cardText?.toLowerCase().includes(app!.name.toLowerCase())) {
          foundCard = true;
          await cards.nth(i).locator('button:has-text("Install")').click();
          break;
        }
      }
    } else {
      await expect(appCard).toBeVisible({ timeout: 10000 });
      const installBtn = appCard.locator('[data-testid="install-app-btn"]').or(
        appCard.locator('button:has-text("Install")')
      );
      await installBtn.click();
    }

    expect(foundCard, 'Application card should be found').toBe(true);
    console.log('Clicked Install button');

    // Wait for configuration dialog to open
    await page.waitForSelector('mat-dialog-container', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    console.log('Configuration dialog opened');

    // Select the addon
    await selectAddon(page, getAddonDisplayName(addonConfig.addon));

    // Fill addon parameters
    await fillAddonParams(page, addonConfig.addonParams, addonConfig.name);

    // Upload addon files if any
    const addonConfigDir = join(__dirname, '..', 'applications', 'ssl-addon');
    await uploadAddonFiles(page, addonConfig.addonFiles, addonConfigDir);

    // Auto-fill required dropdowns (storage, network, etc.)
    await helper.autoFillRequiredDropdowns();
    console.log('Auto-filled required dropdowns');

    // Click Install button
    const installButton = page.locator('mat-dialog-container button:has-text("Install")');
    await expect(installButton).toBeEnabled({ timeout: 10000 });
    await installButton.click();
    console.log('Installation started');

    // Wait for installation to complete
    const installed = await helper.waitForInstallationComplete(app!.name);
    expect(installed, 'Installation should complete successfully').toBe(true);
    console.log('Installation complete');

    // Extract created container VMID
    const createdVmId = await helper.extractCreatedVmId(app!.name);
    expect(createdVmId, 'Container VMID must be extracted').toBeTruthy();
    console.log(`Created container VMID: ${createdVmId}`);

    // Validate addon via SSH
    if (addonConfig.validation && createdVmId) {
      await validateAddon(page, addonConfig, createdVmId);
    }

    // Cleanup old containers
    if (createdVmId) {
      const cleanupValidator = new SSHValidator({ sshHost: getPveHost(), sshPort: SSH_PORT });
      const cleanupResult = cleanupValidator.cleanupOldContainers(
        app!.applicationId, createdVmId, getDeployerStaticIp(),
      );
      console.log(`Container cleanup: ${cleanupResult.message}`);
    }
  });

  test('install node-red with samba-shares addon', async ({ page }) => {
    const addonConfig = loadAddonConfig('samba-addon');
    console.log(`Testing addon: ${addonConfig.addon} on base application: ${addonConfig.baseApplication}`);

    const app = applications.find((a) => a.name === addonConfig.baseApplication);
    expect(app, `Base application ${addonConfig.baseApplication} should exist`).toBeDefined();

    const helper = new ApplicationInstallHelper(page);

    // Cleanup existing application
    console.log(`Cleaning up existing application: ${app!.applicationId}`);
    const cleanup = helper.cleanupApplication(app!.applicationId);
    console.log(`Cleanup result: ${cleanup.message}`);

    // Create the base application via wizard (Save only, no install yet)
    console.log(`Creating application: ${app!.name}`);
    await helper.createApplication(app!, { installAfterSave: false });
    console.log(`Application created: ${app!.name}`);

    // Navigate to Applications page
    await page.goto('/applications');
    await page.waitForLoadState('networkidle');
    console.log('Navigated to Applications page');

    // Find the created application card and click Install
    const appCard = page.locator('.card').filter({
      has: page.locator(`h2:text-is("${app!.name}"), h2:text-is("${app!.applicationId}")`)
    }).first();

    let foundCard = await appCard.count() > 0;
    if (!foundCard) {
      console.log('Card not found by exact match, trying partial match...');
      const cards = page.locator('.card');
      const count = await cards.count();
      for (let i = 0; i < count; i++) {
        const cardText = await cards.nth(i).textContent();
        if (cardText?.toLowerCase().includes(app!.name.toLowerCase())) {
          foundCard = true;
          await cards.nth(i).locator('button:has-text("Install")').click();
          break;
        }
      }
    } else {
      await expect(appCard).toBeVisible({ timeout: 10000 });
      const installBtn = appCard.locator('[data-testid="install-app-btn"]').or(
        appCard.locator('button:has-text("Install")')
      );
      await installBtn.click();
    }

    expect(foundCard, 'Application card should be found').toBe(true);
    console.log('Clicked Install button');

    // Wait for configuration dialog to open
    await page.waitForSelector('mat-dialog-container', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    console.log('Configuration dialog opened');

    // Select the addon
    await selectAddon(page, getAddonDisplayName(addonConfig.addon));

    // Fill addon parameters
    await fillAddonParams(page, addonConfig.addonParams, addonConfig.name);

    // Upload addon files if any
    const addonConfigDir = join(__dirname, '..', 'applications', 'samba-addon');
    await uploadAddonFiles(page, addonConfig.addonFiles, addonConfigDir);

    // Auto-fill required dropdowns (storage, network, etc.)
    await helper.autoFillRequiredDropdowns();
    console.log('Auto-filled required dropdowns');

    // Click Install button
    const installButton = page.locator('mat-dialog-container button:has-text("Install")');
    await expect(installButton).toBeEnabled({ timeout: 10000 });
    await installButton.click();
    console.log('Installation started');

    // Wait for installation to complete
    const installed = await helper.waitForInstallationComplete(app!.name);
    expect(installed, 'Installation should complete successfully').toBe(true);
    console.log('Installation complete');

    // Extract created container VMID
    const createdVmId = await helper.extractCreatedVmId(app!.name);
    expect(createdVmId, 'Container VMID must be extracted').toBeTruthy();
    console.log(`Created container VMID: ${createdVmId}`);

    // Validate addon via SSH
    if (addonConfig.validation && createdVmId) {
      await validateAddon(page, addonConfig, createdVmId);
    }

    // Cleanup old containers
    if (createdVmId) {
      const cleanupValidator = new SSHValidator({ sshHost: getPveHost(), sshPort: SSH_PORT });
      const cleanupResult = cleanupValidator.cleanupOldContainers(
        app!.applicationId, createdVmId, getDeployerStaticIp(),
      );
      console.log(`Container cleanup: ${cleanupResult.message}`);
    }
  });
});
