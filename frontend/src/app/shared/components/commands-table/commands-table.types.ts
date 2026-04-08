export interface ICommandRow {
  seq: number;
  name: string;
  badges: ICommandBadge[];
  skipped: boolean;
  details: ICommandDetail[];
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
