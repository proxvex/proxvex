import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ICommandRow } from './commands-table.types';

@Component({
  selector: 'app-commands-table',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './commands-table.html',
  styleUrl: './commands-table.scss',
})
export class CommandsTableComponent {
  @Input() commands: ICommandRow[] = [];

  expandedSeq: number | null = null;

  toggle(seq: number): void {
    this.expandedSeq = this.expandedSeq === seq ? null : seq;
  }
}
