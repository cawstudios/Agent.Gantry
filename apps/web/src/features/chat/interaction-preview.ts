export type InteractionPreview =
  | {
      kind: 'question';
      title: string;
      prompt: string;
      options: string[];
      disabled?: boolean;
    }
  | {
      kind: 'approval';
      title: string;
      summary: string;
      risk: 'low' | 'medium' | 'high';
      disabled?: boolean;
    }
  | {
      kind: 'todo';
      title: string;
      items: { label: string; status: 'done' | 'active' | 'pending' }[];
    }
  | { kind: 'progress'; label: string; detail: string; value: number }
  | { kind: 'file'; name: string; size: string; mediaType: string }
  | {
      kind: 'receipt';
      outcome: string;
      used: string;
      changed: string;
      delegated: boolean;
      attention: string;
    }
  | { kind: 'fact'; label: string; value: string; provenance: string }
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'table'; title: string; columns: string[]; rows: string[][] }
  | {
      kind: 'form';
      title: string;
      fields: { label: string; value: string }[];
      disabled?: boolean;
    }
  | { kind: 'media'; title: string; caption: string; mediaType: string }
  | {
      kind: 'dependency';
      name: string;
      status: 'ready' | 'blocked';
      detail: string;
    };
