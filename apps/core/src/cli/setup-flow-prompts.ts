import * as p from '@clack/prompts';

import { type FlowAction, toAction } from './setup-flow-control.js';

export async function chooseProgressAction(options: {
  message: string;
  continueLabel?: string;
  includeBack?: boolean;
}): Promise<FlowAction> {
  const value = await p.select({
    message: options.message,
    options: [
      {
        value: 'next',
        label: options.continueLabel || 'Continue',
      },
      ...(options.includeBack
        ? [
            {
              value: 'back',
              label: 'Back',
            },
          ]
        : []),
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
  });
  return toAction(value);
}
