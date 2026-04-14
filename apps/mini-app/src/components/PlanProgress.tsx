import { Progress, Subheadline } from '@telegram-apps/telegram-ui';
import { Plan } from '../types/plan';

export function PlanProgress({ plan }: { plan: Plan }) {
  const approved = plan.sections.filter(
    (section) => section.status === 'approved' || section.status === 'done',
  ).length;
  const total = Math.max(1, plan.sections.length);
  const percent = Math.round((approved / total) * 100);

  return (
    <div className="plan-progress">
      <Progress value={percent} />
      <Subheadline className="plan-progress-label">
        {approved}/{plan.sections.length} approved
      </Subheadline>
    </div>
  );
}
