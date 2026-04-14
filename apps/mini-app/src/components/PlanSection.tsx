import { useState } from 'react';
import { Cell, Section, Text } from '@telegram-apps/telegram-ui';

import { selectionChanged } from '../lib/telegram';
import { PlanSection as PlanSectionType } from '../types/plan';
import { InlineEditor } from './InlineEditor';
import { SectionActions } from './SectionActions';
import { StatusBadge } from './StatusBadge';

interface PlanSectionProps {
  section: PlanSectionType;
  onApprove: (sectionIndex: number) => Promise<void>;
  onReject: (sectionIndex: number, reason: string) => Promise<void>;
  onEdit: (sectionIndex: number, content: string) => Promise<void>;
}

export function PlanSection({
  section,
  onApprove,
  onReject,
  onEdit,
}: PlanSectionProps) {
  const [expanded, setExpanded] = useState(section.status === 'pending');
  const [editing, setEditing] = useState(false);

  return (
    <Section className="plan-section">
      <Cell
        className="plan-section-header"
        subtitle={<Text>{section.status}</Text>}
        after={<StatusBadge status={section.status} />}
        onClick={() => {
          selectionChanged();
          setExpanded((current) => !current);
        }}
      >
        {section.index + 1}. {section.title}
      </Cell>

      {expanded ? (
        <div className="plan-section-body">
          <pre>{section.content}</pre>

          {editing ? (
            <InlineEditor
              initialValue={section.content}
              onCancel={() => setEditing(false)}
              onSubmit={async (value) => {
                await onEdit(section.index, value);
                setEditing(false);
              }}
            />
          ) : (
            <SectionActions
              onApprove={() => onApprove(section.index)}
              onReject={() => onReject(section.index, 'Rejected from Mini App')}
              onSuggestEdit={() => setEditing(true)}
            />
          )}
        </div>
      ) : null}
    </Section>
  );
}
