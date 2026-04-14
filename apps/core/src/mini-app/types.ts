export const PLAN_STATUS_VALUES = [
  'draft',
  'reviewing',
  'approved',
  'rejected',
  'executing',
] as const;

export const PLAN_SECTION_STATUS_VALUES = [
  'pending',
  'approved',
  'rejected',
  'editing',
  'executing',
  'done',
] as const;

export type PlanStatus = (typeof PLAN_STATUS_VALUES)[number];
export type PlanSectionStatus = (typeof PLAN_SECTION_STATUS_VALUES)[number];

export interface PlanSection {
  index: number;
  title: string;
  content: string;
  status: PlanSectionStatus;
  userFeedback?: string;
  agentRevision?: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface Plan {
  id: string;
  groupFolder: string;
  chatJid?: string;
  title: string;
  status: PlanStatus;
  sections: PlanSection[];
  createdAt: string;
  updatedAt: string;
  agentSessionId?: string;
}

export type PlanEvent =
  | {
      type: 'section_approved';
      planId: string;
      sectionIndex: number;
      userId: string;
      timestamp: string;
    }
  | {
      type: 'section_rejected';
      planId: string;
      sectionIndex: number;
      userId: string;
      reason?: string;
      timestamp: string;
    }
  | {
      type: 'section_edited';
      planId: string;
      sectionIndex: number;
      userId: string;
      newContent: string;
      timestamp: string;
    }
  | {
      type: 'plan_approved';
      planId: string;
      userId: string;
      timestamp: string;
    }
  | {
      type: 'plan_rejected';
      planId: string;
      userId: string;
      reason?: string;
      timestamp: string;
    };

export interface PlanSectionInput {
  title: string;
  content: string;
}
