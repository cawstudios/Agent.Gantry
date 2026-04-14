export type PlanStatus =
  | 'draft'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'executing';

export type PlanSectionStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'editing'
  | 'executing'
  | 'done';

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
