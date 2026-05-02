# MyClaw Channel Provider Adapters

## Add A Provider Adapter In 5 Minutes

Create a provider file under `apps/core/src/channels/<name>.ts` and export a `Provider`:

```ts
import type { Provider } from './provider-registry.js';

export const exampleProvider: Provider = {
  id: 'example',
  label: 'Example',
  jidPrefix: 'ex:',
  folderPrefix: 'example_',
  isGroupJid: (jid) => jid.startsWith('ex:g:'),
  formatting: 'markdown-native',
  isEnabled: (settings) => settings.providers?.example?.enabled ?? false,
  create: () => null,
  setup: {
    envKeys: [],
    describe: () => 'Example channel',
    run: async () => {},
  },
};
```

Register it in `apps/core/src/channels/register-builtins.ts` with `registerProvider(exampleProvider)`.

## Capability Ports

Provider adapters can implement these optional ports based on what the transport supports:

- `StreamingSink`
- `TypingSink`
- `ProgressSink`
- `InteractionSurface`
- `PlanReviewSurface`
- `GroupDiscoverySource`

All ports are structural and opt-in. Implement only what your channel supports.

## Where Provider Id Is Used

A provider `id` becomes:

- `settings.yaml` key under `providers.<id>`
- provider connection records under `provider_connections.*`
- conversation records under `conversations.*`
- binding records under `bindings.*`
- conversation approvers on `conversations.<id>.control_approvers`

A provider `jidPrefix` is used for:

- JID ownership lookup (`providerForJid`)
- registered group summary queries (`jid LIKE '<prefix>%'`)

A provider `folderPrefix` is used for group folder naming conventions.
