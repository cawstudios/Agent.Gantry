import { useState } from 'react';
import { Button, Textarea } from '@telegram-apps/telegram-ui';
import { impact } from '../lib/telegram';

interface InlineEditorProps {
  initialValue: string;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}

export function InlineEditor({
  initialValue,
  onSubmit,
  onCancel,
}: InlineEditorProps) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);

  return (
    <div className="inline-editor">
      <Textarea
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        rows={8}
      />
      <div className="inline-editor-actions">
        <Button
          type="button"
          size="s"
          mode="filled"
          loading={saving}
          onClick={() => {
            impact('medium');
            setSaving(true);
            void onSubmit(value).finally(() => setSaving(false));
          }}
        >
          Submit
        </Button>
        <Button
          type="button"
          size="s"
          mode="outline"
          onClick={() => {
            impact('light');
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
