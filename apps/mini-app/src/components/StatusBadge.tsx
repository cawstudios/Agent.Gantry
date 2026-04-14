import { Badge } from '@telegram-apps/telegram-ui';
import { PlanSectionStatus } from '../types/plan';

const LABELS: Record<PlanSectionStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  editing: 'Editing',
  executing: 'Executing',
  done: 'Done',
};

const MODES: Record<
  PlanSectionStatus,
  'primary' | 'critical' | 'secondary' | 'gray'
> = {
  pending: 'gray',
  approved: 'primary',
  rejected: 'critical',
  editing: 'secondary',
  executing: 'secondary',
  done: 'primary',
};

export function StatusBadge({ status }: { status: PlanSectionStatus }) {
  return (
    <Badge type="number" mode={MODES[status]}>
      {LABELS[status]}
    </Badge>
  );
}
