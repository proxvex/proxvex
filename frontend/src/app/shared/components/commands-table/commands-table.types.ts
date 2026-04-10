export type CommandStatus = 'completed' | 'running' | 'failed' | 'finished' | 'pending';

export interface ICommandRow {
  seq: number;
  name: string;
  badges: ICommandBadge[];
  skipped: boolean;
  details: ICommandDetail[];
  /** Execution state (optional — used by process monitor) */
  status?: CommandStatus;
  /** Has stderr output available for viewing */
  hasStderr?: boolean;
  /** Live stderr content (shown inline for running commands) */
  liveStderr?: string;
}

export interface ICommandBadge {
  label: string;
  cls: string;
}

export interface ICommandDetail {
  label: string;
  value: string;
  tooltip?: string;
  type?: 'text' | 'badge' | 'warn';
  /** CSS class for the badge */
  badgeCls?: string;
  /** Badge text shown before the value. If omitted with type='badge', value itself is the badge. */
  badgeLabel?: string;
}
