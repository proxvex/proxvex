import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatCheckboxModule } from '@angular/material/checkbox';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { IUploadFile } from '../../../shared/types';

interface UploadFileRow {
  volume: string;
  filepath: string;
  label: string;
  required: boolean;
  advanced: boolean;
  help: string;
}

@Component({
  selector: 'app-upload-files-step',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule
  ],
  template: `
    <div class="upload-files-step" data-testid="upload-files-step">
      <mat-card>
        <mat-card-header>
          <mat-card-title>
            <mat-icon>upload_file</mat-icon>
            Upload Files
          </mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <p class="description">
            Define files that users can upload during installation.
            Select the target volume and specify the file path within it.
          </p>

          @if (volumePrefixes.length === 0) {
            <p class="no-volumes-hint">
              No volumes defined yet. Define volumes in the Parameters step first.
            </p>
          }

          <!-- Existing file entries -->
          @for (file of files; track $index; let idx = $index) {
            <div class="file-entry" [attr.data-testid]="'upload-file-row-' + idx">
              <div class="file-entry-header">
                <span class="file-entry-number">#{{ idx + 1 }}</span>
                <button type="button" mat-icon-button color="warn" (click)="removeFile(idx)"
                        aria-label="Remove file" [attr.data-testid]="'delete-file-btn-' + idx">
                  <mat-icon>delete</mat-icon>
                </button>
              </div>
              <div class="file-fields">
                <div class="file-fields-row">
                  <mat-form-field appearance="fill" class="field-volume">
                    <mat-label>Volume</mat-label>
                    <mat-select [(ngModel)]="file.volume" [name]="'volume' + idx" (selectionChange)="onRowChange()">
                      @for (v of volumePrefixes; track v) {
                        <mat-option [value]="v">{{ v }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>
                  <mat-form-field appearance="fill" class="field-filepath">
                    <mat-label>File Path</mat-label>
                    <input matInput [(ngModel)]="file.filepath" [name]="'filepath' + idx"
                           placeholder="e.g., mosquitto.conf" (blur)="onRowChange()"
                           [attr.data-testid]="'filepath-input-' + idx" />
                  </mat-form-field>
                  <mat-form-field appearance="fill" class="field-label">
                    <mat-label>Label</mat-label>
                    <input matInput [(ngModel)]="file.label" [name]="'label' + idx"
                           placeholder="Display name (optional)" (blur)="onRowChange()"
                           maxlength="23"
                           [attr.data-testid]="'label-input-' + idx" />
                    <mat-hint align="end">{{ file.label.length }}/23</mat-hint>
                  </mat-form-field>
                </div>
                <div class="file-options-row">
                  <mat-checkbox [(ngModel)]="file.required" [name]="'required' + idx"
                                (change)="onRowChange()"
                                [attr.data-testid]="'required-checkbox-' + idx">
                    Required
                  </mat-checkbox>
                  <mat-checkbox [(ngModel)]="file.advanced" [name]="'advanced' + idx"
                                (change)="onRowChange()"
                                [attr.data-testid]="'advanced-checkbox-' + idx">
                    Advanced
                  </mat-checkbox>
                </div>
                <mat-form-field appearance="fill" class="field-help">
                  <mat-label>Help text (optional)</mat-label>
                  <textarea matInput [(ngModel)]="file.help" [name]="'help' + idx"
                            placeholder="Markdown or URL — shown to the user during file upload"
                            (blur)="onRowChange()" rows="2"
                            [attr.data-testid]="'help-input-' + idx"></textarea>
                  <mat-hint>Supports Markdown. Tip: paste a documentation link.</mat-hint>
                </mat-form-field>
              </div>
            </div>
          }

          <!-- Add new entry -->
          @if (isAddingNew) {
            <div class="file-entry file-entry-new" data-testid="add-file-row">
              <div class="file-entry-header">
                <span class="file-entry-number">New</span>
                <div class="add-actions">
                  <button type="button" mat-icon-button color="primary" (click)="confirmAdd()"
                          [disabled]="!newFile.volume || !newFile.filepath.trim()"
                          matTooltip="Add (Enter)" data-testid="confirm-add-file-btn">
                    <mat-icon>check</mat-icon>
                  </button>
                  <button type="button" mat-icon-button (click)="cancelAdd()"
                          matTooltip="Cancel (Esc)" data-testid="cancel-add-file-btn">
                    <mat-icon>close</mat-icon>
                  </button>
                </div>
              </div>
              <div class="file-fields">
                <div class="file-fields-row">
                  <mat-form-field appearance="fill" class="field-volume">
                    <mat-label>Volume</mat-label>
                    <mat-select [(ngModel)]="newFile.volume" name="newVolume">
                      @for (v of volumePrefixes; track v) {
                        <mat-option [value]="v">{{ v }}</mat-option>
                      }
                    </mat-select>
                  </mat-form-field>
                  <mat-form-field appearance="fill" class="field-filepath">
                    <mat-label>File Path</mat-label>
                    <input matInput [(ngModel)]="newFile.filepath" name="newFilepath"
                           placeholder="e.g., mosquitto.conf"
                           (keyup.enter)="confirmAdd()" (keyup.escape)="cancelAdd()"
                           data-testid="new-filepath-input" />
                  </mat-form-field>
                  <mat-form-field appearance="fill" class="field-label">
                    <mat-label>Label</mat-label>
                    <input matInput [(ngModel)]="newFile.label" name="newLabel"
                           placeholder="Display name (optional)"
                           maxlength="23"
                           (keyup.enter)="confirmAdd()" (keyup.escape)="cancelAdd()"
                           data-testid="new-label-input" />
                    <mat-hint align="end">{{ newFile.label.length }}/23</mat-hint>
                  </mat-form-field>
                </div>
                <div class="file-options-row">
                  <mat-checkbox [(ngModel)]="newFile.required" name="newRequired">
                    Required
                  </mat-checkbox>
                  <mat-checkbox [(ngModel)]="newFile.advanced" name="newAdvanced">
                    Advanced
                  </mat-checkbox>
                </div>
                <mat-form-field appearance="fill" class="field-help">
                  <mat-label>Help text (optional)</mat-label>
                  <textarea matInput [(ngModel)]="newFile.help" name="newHelp"
                            placeholder="Markdown or URL — shown to the user during file upload"
                            (keyup.escape)="cancelAdd()" rows="2"
                            data-testid="new-help-input"></textarea>
                  <mat-hint>Supports Markdown. Tip: paste a documentation link.</mat-hint>
                </mat-form-field>
              </div>
            </div>
          }

          <!-- Add button -->
          @if (!isAddingNew) {
            <div class="add-trigger">
              <button type="button" mat-stroked-button color="primary" (click)="startAdd()"
                      [disabled]="volumePrefixes.length === 0" data-testid="add-file-btn">
                <mat-icon>add</mat-icon>
                Add file
              </button>
            </div>
          }

          <div class="examples">
            <p><strong>How it works:</strong></p>
            <p class="examples-intro">
              Select the <strong>Volume</strong> where the file should be placed, then enter the <strong>File Path</strong> within that volume.
              The <strong>Label</strong> is shown to the user during installation.
              Use <strong>Help text</strong> to explain the expected file format or link to documentation.
            </p>

            <p class="examples-note">
              <strong>Required</strong> files must be uploaded before installation can start.
              <strong>Advanced</strong> files are hidden by default and only shown when the user clicks "Show Advanced".
            </p>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .upload-files-step {
      padding: 1rem 0;
    }

    mat-card-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .description {
      margin-bottom: 1rem;
      color: rgba(0, 0, 0, 0.6);
    }

    .no-volumes-hint {
      color: #e65100;
      font-size: 0.85rem;
      font-style: italic;
      margin-bottom: 1rem;
    }

    /* File entry card */
    .file-entry {
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      margin-bottom: 0.75rem;
      background: #fafafa;
    }

    .file-entry-new {
      border-color: #1976d2;
      border-style: dashed;
      background: #e3f2fd;
    }

    .file-entry-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.25rem;
    }

    .file-entry-number {
      font-size: 0.75rem;
      font-weight: 600;
      color: rgba(0, 0, 0, 0.4);
      text-transform: uppercase;
    }

    .add-actions {
      display: flex;
      gap: 0;
    }

    /* Fields layout */
    .file-fields {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .file-fields-row {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .field-volume {
      flex: 0 0 120px;
      min-width: 100px;
    }

    .field-filepath {
      flex: 1;
      min-width: 150px;
    }

    .field-label {
      flex: 1;
      min-width: 150px;
    }

    .file-options-row {
      display: flex;
      gap: 1.5rem;
      margin-bottom: 0.5rem;
    }

    .field-help {
      width: 100%;
    }

    .add-trigger {
      margin-top: 0.5rem;
      margin-bottom: 1rem;
    }

    .add-trigger button {
      gap: 0.25rem;
    }

    /* Examples */
    .examples {
      margin-top: 1rem;
      padding: 1rem;
      background: #f5f5f5;
      border-radius: 8px;
      border-left: 4px solid #90a4ae;
    }

    .examples p {
      margin: 0 0 0.5rem 0;
      font-size: 0.85rem;
      color: #37474f;
    }

    .examples-intro {
      line-height: 1.5;
    }

    .examples-note {
      margin-top: 0.25rem;
      margin-bottom: 0;
      line-height: 1.5;
    }
  `]
})
export class UploadFilesStepComponent {
  readonly state = inject(CreateApplicationStateService);

  files: UploadFileRow[] = [];
  isAddingNew = false;
  newFile: UploadFileRow = this.emptyRow();

  /** Extract volume prefixes from volumes parameter or compose properties.
   *  Priority: installForm (user-editable in Step 3) > parameterForm > composeProperties (initial parse). */
  get volumePrefixes(): string[] {
    const volumesValue =
      this.state.installForm.get('volumes')?.value
      || this.state.parameterForm.get('volumes')?.value
      || this.state.composeProperties()?.volumes;
    if (!volumesValue || typeof volumesValue !== 'string') {
      return [];
    }
    return volumesValue
      .split('\n')
      .map(line => line.split('=')[0]?.trim())
      .filter((prefix): prefix is string => !!prefix);
  }

  constructor() {
    this.syncFromState();
  }

  private emptyRow(): UploadFileRow {
    return { volume: '', filepath: '', label: '', required: false, advanced: false, help: '' };
  }

  private syncFromState(): void {
    const stateFiles = this.state.getUploadFiles();
    this.files = stateFiles.map(f => {
      const colonIdx = f.destination.indexOf(':');
      return {
        volume: colonIdx >= 0 ? f.destination.slice(0, colonIdx) : '',
        filepath: colonIdx >= 0 ? f.destination.slice(colonIdx + 1) : f.destination,
        label: f.label ?? '',
        required: f.required ?? false,
        advanced: f.advanced ?? false,
        help: f.help ?? ''
      };
    });
  }

  startAdd(): void {
    this.isAddingNew = true;
    const prefixes = this.volumePrefixes;
    this.newFile = {
      ...this.emptyRow(),
      volume: prefixes.length > 0 ? prefixes[0] : ''
    };
  }

  confirmAdd(): void {
    if (!this.newFile.volume || !this.newFile.filepath.trim()) return;

    this.files.push({ ...this.newFile });
    this.isAddingNew = false;
    this.newFile = this.emptyRow();
    this.syncToState();
  }

  /** Auto-confirm pending new file entry when leaving the step. */
  autoConfirmPendingAdd(): void {
    if (this.isAddingNew && this.newFile.volume && this.newFile.filepath.trim()) {
      this.confirmAdd();
    }
  }

  cancelAdd(): void {
    this.isAddingNew = false;
    this.newFile = this.emptyRow();
  }

  removeFile(index: number): void {
    this.files.splice(index, 1);
    this.syncToState();
  }

  onRowChange(): void {
    this.syncToState();
  }

  private syncToState(): void {
    const uploadFiles: IUploadFile[] = this.files
      .filter(f => f.volume && f.filepath.trim())
      .map(f => {
        const destination = `${f.volume}:${f.filepath.trim()}`;
        const result: IUploadFile = {
          destination,
          required: f.required,
          advanced: f.advanced
        };
        if (f.label.trim()) {
          result.label = f.label.trim();
        }
        if (f.help.trim()) {
          result.help = f.help.trim();
        }
        return result;
      });
    this.state.setUploadFiles(uploadFiles);
  }
}
