import { Component, Input, Output, EventEmitter, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import * as yaml from 'js-yaml';
import { IParameter, IJsonError, IStack, ParameterTarget } from '../../shared/types';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { DockerComposeService } from '../shared/services/docker-compose.service';
import { StackSelectorComponent } from '../shared/components/stack-selector/stack-selector.component';

@Component({
  selector: 'app-parameter-group',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatSlideToggleModule,
    MatIconModule,
    MatButtonModule,
    MatExpansionModule,
    MatButtonToggleModule,
    MatCardModule,
    StackSelectorComponent
  ],
  templateUrl: './parameter-group.component.html',
  styleUrl: './parameter-group.component.scss'
})
export class ParameterGroupComponent implements OnInit {
  @Input({ required: true }) groupName!: string;
  @Input({ required: true }) groupedParameters!: Record<string, IParameter[]>;
  @Input({ required: true }) form!: FormGroup;
  @Input({ required: true }) showAdvanced!: boolean;

  // Classification inputs/outputs (create-application only)
  @Input() showClassification = false;
  @Input() parameterClassifications = new Map<string, ParameterTarget>();
  @Output() classificationChanged = new EventEmitter<{ paramId: string; target: ParameterTarget }>();

  // Stack selection inputs/outputs
  @Input() availableStacks: IStack[] = [];
  @Output() stackSelected = new EventEmitter<IStack>();
  @Output() createStackRequested = new EventEmitter<void>();

  private errorHandler = inject(ErrorHandlerService);
  private sanitizer = inject(DomSanitizer);
  private composeService = inject(DockerComposeService);
  expandedHelp: Record<string, boolean> = {};
  
  // Stack uploaded file names for display
  uploadedFileNames: Record<string, string> = {};
  
  // Extracted compose properties
  composeProperties = signal<{
    services?: string;
    ports?: string;
    images?: string;
    networks?: string;
  } | null>(null);

  // Secret env file upload - stacks uploaded filename for display
  secretEnvFileName = '';

  // Stack selection state
  selectedStack: IStack | null = null;

  onStackSelect(stack: IStack): void {
    this.selectedStack = stack;
    this.stackSelected.emit(stack);
  }

  onCreateStack(): void {
    this.createStackRequested.emit();
  }

  hasStacksAvailable(): boolean {
    return this.availableStacks.length > 0;
  }

  // ==================== Marker Detection (delegates to service) ====================

  /** Checks if envs control contains {{ }} markers */
  envsHasMarkers(): boolean {
    const value = this.form.get('envs')?.value;
    return this.composeService.hasMarkers(value);
  }

  /** Checks if env_file control contains {{ }} markers (base64 encoded) */
  envFileHasMarkers(): boolean {
    const value = this.form.get('env_file')?.value;
    return value ? this.composeService.hasMarkersInBase64(value) : false;
  }

  /** Extracts marker names from envs */
  getEnvMarkers(): string[] {
    const value = this.form.get('envs')?.value;
    return this.composeService.extractMarkers(value);
  }

  /** Extracts marker names from env_file (base64 encoded) */
  getEnvFileMarkers(): string[] {
    const value = this.form.get('env_file')?.value;
    return value ? this.composeService.extractMarkersFromBase64(value) : [];
  }

  // ==================== Secret Env File Upload ====================

  /**
   * Handles secret .env file upload for envs field - replaces markers in plain text
   */
  async onSecretEnvFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    this.secretEnvFileName = file.name;

    try {
      const content = await this.readFileAsText(file);
      const envVars = this.composeService.parseEnvFileText(content);

      // Replace markers in envs (plain text)
      const envsControl = this.form.get('envs');
      if (envsControl && typeof envsControl.value === 'string') {
        envsControl.setValue(this.composeService.replaceMarkers(envsControl.value, envVars));
      }
    } catch (error) {
      this.errorHandler.handleError('Failed to read .env file', error);
    }

    input.value = '';
  }

  /**
   * Handles secret .env file upload for env_file field - replaces markers in base64 content
   */
  async onSecretEnvFileSelectedForEnvFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];
    this.secretEnvFileName = file.name;

    try {
      const content = await this.readFileAsText(file);
      const envVars = this.composeService.parseEnvFileText(content);

      // Replace markers in env_file (base64 encoded)
      const envFileControl = this.form.get('env_file');
      if (envFileControl && typeof envFileControl.value === 'string') {
        envFileControl.setValue(this.composeService.replaceMarkersInBase64(envFileControl.value, envVars));
      }
    } catch (error) {
      this.errorHandler.handleError('Failed to read .env file', error);
    }

    input.value = '';
  }

  private readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  getTooltip(param: IParameter): string | undefined {
    // Only show tooltip if help is not expandable
    if (this.hasExpandableHelp(param)) {
      return undefined;
    }
    return param.description;
  }

  hasExpandableHelp(param: IParameter): boolean {
    const desc = param.description || '';
    // Check for markdown indicators: newlines, list markers, code blocks, etc.
    return desc.length > 150 || 
           desc.includes('\n') || 
           desc.includes('- ') ||
           desc.includes('* ') ||
           desc.includes('```') ||
           desc.includes('Example:') ||
           desc.includes('Format:');
  }

  toggleHelp(paramId: string): void {
    this.expandedHelp[paramId] = !this.expandedHelp[paramId];
  }

  isHelpExpanded(paramId: string): boolean {
    return this.expandedHelp[paramId] || false;
  }

  getMarkdownHelp(param: IParameter): SafeHtml {
    const markdown = param.description || '';
    const html = marked.parse(markdown, { async: false }) as string;
    return this.sanitizer.sanitize(1, html) || '';
  }

  getEnumOptionLabel(option: string | { name: string; value: string | number | boolean }): string {
    return typeof option === 'string' ? option : option.name;
  }

  getEnumOptionValue(option: string | { name: string; value: string | number | boolean }): string | number | boolean {
    return typeof option === 'string' ? option : option.value;
  }

  isVisible(param: IParameter): boolean {
    // Don't render if form control doesn't exist
    // Use controls[] instead of get() because get() treats dots as path separators
    if (!this.form.controls[param.id]) return false;
    if (param.advanced && !this.showAdvanced) return false;
    // Check 'if' condition
    if (param.if && !this.evaluateCondition(param.if)) return false;
    // For enum parameters with enumValuesTemplate, only hide if enumValues is an empty array
    // Show the field if enumValues is undefined (error case) or has values
    if (param.type === 'enum' && param.enumValues !== undefined) {
      // Only hide if it's an empty array (no devices found)
      // Show if undefined (error) or has values
      if (Array.isArray(param.enumValues) && param.enumValues.length === 0) {
        return false;
      }
    }
    return true;
  }

  isGroupVisible(): boolean {
    const params = this.groupedParameters[this.groupName];
    return params?.some(p => this.isVisible(p)) ?? false;
  }

  /**
   * Evaluates a condition for param.if.
   * Special conditions like 'env_file_has_markers' are computed from other controls.
   */
  private evaluateCondition(condition: string): boolean {
    // Special: env_file_has_markers - check if envs or env_file contains {{ }} markers
    if (condition === 'env_file_has_markers') {
      return this.envsHasMarkers() || this.envFileHasMarkers();
    }
    // Default: check form control value
    return !!this.form.get(condition)?.value;
  }

  get params(): IParameter[] {
    return this.groupedParameters[this.groupName] || [];
  }

  async onFileSelected(event: Event, paramId: string): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      try {
        const base64 = await this.readFileAsBase64(file);
        // Store the base64 value with filename metadata: file:filename:content:base64content
        const valueWithMetadata = `file:${file.name}:content:${base64}`;
        this.form.get(paramId)?.setValue(valueWithMetadata);
        this.form.get(paramId)?.markAsTouched();
        
        // Store filename for display
        this.uploadedFileNames[paramId] = file.name;
        
        // If this is compose_file, extract properties
        if (paramId === 'compose_file') {
          await this.extractComposeProperties(base64);
        }
      } catch (error) {
        const errors: IJsonError[] = [{
          name: 'FileReadError',
          message: `Failed to read file: ${error}`,
          details: undefined
        } as IJsonError];
        this.errorHandler.showErrorDialog(errors);
      }
    }
  }
  
  getDisplayValue(paramId: string): string {
    const value = this.form.get(paramId)?.value;
    if (!value) {
      return '';
    }
    
    // Check if value has file metadata format: file:filename:content:base64content
    const fileMetadataMatch = typeof value === 'string' && value.match(/^file:([^:]+):content:(.+)$/);
    if (fileMetadataMatch) {
      const filename = fileMetadataMatch[1];
      // const base64Content = fileMetadataMatch[2]; // Not used currently, but kept for future use
      // Store filename for later use
      this.uploadedFileNames[paramId] = filename;
      return `base64:${filename}`;
    }
    
    // Check if it's a base64 string (long string without spaces/newlines, base64 chars only)
    const isBase64 = typeof value === 'string' && 
                     value.length > 50 && 
                     /^[A-Za-z0-9+/=]+$/.test(value) &&
                     !value.includes(' ') &&
                     !value.includes('\n');
    
    if (isBase64) {
      // Check if we have a stored filename
      if (this.uploadedFileNames[paramId]) {
        return `base64:${this.uploadedFileNames[paramId]}`;
      }
      // Otherwise, show generic message with size
      const size = Math.round(value.length * 0.75 / 1024); // Approximate size in KB
      return `base64:${size}KB file uploaded`;
    }
    
    return value;
  }
  
  isBase64Value(paramId: string): boolean {
    const value = this.form.get(paramId)?.value;
    if (!value || typeof value !== 'string') {
      return false;
    }
    
    // Check if it has file metadata format
    if (value.match(/^file:[^:]+:content:.+$/)) {
      return true;
    }
    
    // Check if it's a base64 string
    return value.length > 50 && 
           /^[A-Za-z0-9+/=]+$/.test(value) &&
           !value.includes(' ') &&
           !value.includes('\n');
  }
  
  getBase64Content(paramId: string): string {
    const value = this.form.get(paramId)?.value;
    if (!value || typeof value !== 'string') {
      return '';
    }
    
    // Extract base64 content from file metadata format
    const fileMetadataMatch = value.match(/^file:[^:]+:content:(.+)$/);
    if (fileMetadataMatch) {
      return fileMetadataMatch[1];
    }
    
    // If it's plain base64, return as-is
    return value;
  }
  
  ngOnInit(): void {
    // Check for existing base64 values and try to extract filenames
    Object.keys(this.groupedParameters).forEach(groupName => {
      const params = this.groupedParameters[groupName];
      params.forEach(param => {
        if (param.upload) {
          const value = this.form.get(param.id)?.value;
          if (value && typeof value === 'string') {
            // Check if value has file metadata format: file:filename:content:base64content
            const fileMetadataMatch = value.match(/^file:([^:]+):content:(.+)$/);
            if (fileMetadataMatch) {
              const filename = fileMetadataMatch[1];
              this.uploadedFileNames[param.id] = filename;
            } else if (this.isBase64Value(param.id)) {
              // Try to get filename from parameter ID mapping or parameter name
              const filename = this.getDefaultFilenameForParam(param);
              if (filename) {
                this.uploadedFileNames[param.id] = filename;
              } else {
                // Generic display for existing base64 values without filename
                const size = Math.round(value.length * 0.75 / 1024);
                this.uploadedFileNames[param.id] = `${size}KB file`;
              }
            }
          }
        }
      });
    });
  }
  
  private getDefaultFilenameForParam(param: IParameter): string | null {
    // Map common parameter IDs to their expected filenames
    const filenameMap: Record<string, string> = {
      'compose_file': 'docker-compose.yml',
      'env_file': '.env',
      'docker_compose_file': 'docker-compose.yml',
      'docker_compose_yaml': 'docker-compose.yaml',
    };
    
    // Check if parameter ID matches a known filename
    if (filenameMap[param.id]) {
      return filenameMap[param.id];
    }
    
    // Try to extract filename from parameter name or description
    const searchText = `${param.name} ${param.description || ''}`.toLowerCase();
    
    // Check for explicit filename in parentheses, e.g., "Environment File (.env)"
    const parenMatch = searchText.match(/\(([a-zA-Z0-9_.-]+)\)/);
    if (parenMatch && parenMatch[1].includes('.')) {
      return parenMatch[1];
    }
    
    // Check if parameter name contains common file patterns
    if (searchText.includes('docker-compose') || searchText.includes('compose file')) {
      return 'docker-compose.yml';
    }
    if (searchText.includes('env file') || searchText.includes('.env')) {
      return '.env';
    }
    
    // Try to extract filename pattern from name/description
    const filePatternMatch = searchText.match(/([a-zA-Z0-9_.-]+\.(yml|yaml|env|json|txt|conf|config|ini|sh|bash|pem|key|crt|cert))/i);
    if (filePatternMatch) {
      return filePatternMatch[1];
    }
    
    return null;
  }

  private async extractComposeProperties(base64OrValue: string): Promise<void> {
    // Extract base64 content if value has file metadata format
    const base64 = base64OrValue.match(/^file:[^:]+:content:(.+)$/)?.[1] || base64OrValue;
    try {
      // Decode base64 to text
      const text = atob(base64);
      
      // Parse YAML
      const composeData = yaml.load(text) as Record<string, unknown>;
      
      if (!composeData) {
        return;
      }
      
      const properties: {
        services?: string;
        ports?: string;
        images?: string;
        networks?: string;
      } = {};
      
      // Extract service names
      const services = (composeData['services'] as Record<string, unknown>) || {};
      const serviceNames = Object.keys(services);
      if (serviceNames.length > 0) {
        properties.services = serviceNames.join(', ');
      }
      
      // Extract port mappings
      const portMappings: string[] = [];
      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        const service = serviceConfig as { ports?: (string | { published?: unknown; target?: unknown })[] };
        if (service.ports) {
          for (const portSpec of service.ports) {
            if (typeof portSpec === 'string') {
              const parts = portSpec.split(':');
              if (parts.length >= 2) {
                const containerPort = parts[parts.length - 1].split('/')[0];
                const hostPort = parts.length > 1 ? parts[parts.length - 2] : parts[0];
                portMappings.push(`${serviceName}:${hostPort}->${containerPort}`);
              }
            } else if (typeof portSpec === 'object' && (portSpec as { published?: unknown; target?: unknown }).published && (portSpec as { published?: unknown; target?: unknown }).target) {
              const portObj = portSpec as { published: number | string; target: number | string };
              portMappings.push(`${serviceName}:${portObj.published}->${portObj.target}`);
            }
          }
        }
      }
      if (portMappings.length > 0) {
        properties.ports = portMappings.join('\n');
      }
      
      // Extract image tags
      const imageTags: string[] = [];
      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        const service = serviceConfig as Record<string, unknown>;
        const image = service['image'];
        if (image && typeof image === 'string') {
          const tag = image.includes(':') ? image.split(':')[1] : 'latest';
          imageTags.push(`${serviceName}:${tag}`);
        }
      }
      if (imageTags.length > 0) {
        properties.images = imageTags.join('\n');
      }
      
      // Extract network names
      const networks = composeData['networks'];
      if (networks && typeof networks === 'object') {
        const networkKeys = Object.keys(networks);
        if (networkKeys.length > 0) {
          properties.networks = networkKeys.join(', ');
        }
      }
      
      // Set properties in hidden form fields (if they exist)
      if (properties.services && this.form.get('compose_services')) {
        this.form.get('compose_services')?.setValue(properties.services);
      }
      if (properties.ports && this.form.get('compose_ports')) {
        this.form.get('compose_ports')?.setValue(properties.ports);
      }
      if (properties.images && this.form.get('compose_images')) {
        this.form.get('compose_images')?.setValue(properties.images);
      }
      if (properties.networks && this.form.get('compose_networks')) {
        this.form.get('compose_networks')?.setValue(properties.networks);
      }
      
      // Update signal for display
      this.composeProperties.set(properties);
    } catch (error) {
      // Silently fail - not critical if extraction fails
      console.warn('Failed to extract compose properties:', error);
      this.composeProperties.set(null);
    }
  }

  private readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // ==================== Classification helpers ====================

  getClassification(paramId: string): ParameterTarget {
    return this.parameterClassifications.get(paramId) ?? 'install';
  }

  onClassificationChange(paramId: string, target: ParameterTarget): void {
    this.classificationChanged.emit({ paramId, target });
  }
}

