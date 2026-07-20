# App Runtime Event Stream

## Acceptance criteria

- An application API key can replay and stream only its own durable runtime events.
- The same cursor contract covers chat, interactions, live runs, and job runs.
- Session messages may carry an explicit model alias selected by the application.
- Existing session event routes and Gantry webhook support remain unchanged.

Write scope: control-server routing/OpenAPI, runtime event projection, session-message controls, and `@gantry/sdk`.

## Surface Impact Matrix

| Surface                      | Classification       | Reason                                                                                                                        |
| ---------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed              | App-scoped durable events can be replayed and streamed.                                                                       |
| `settings.yaml`              | Unchanged by design  | The endpoint uses existing runtime event storage and API-key app identity.                                                    |
| Postgres/runtime projection  | Changed              | Existing event records expose job, run, trigger, conversation, thread, and correlation identifiers. No migration is required. |
| Control API                  | Changed              | Adds `GET /v1/runtime-events`; session message input accepts `model_alias`.                                                   |
| SDK/contracts                | Changed              | Adds runtime-event list/stream methods and fields.                                                                            |
| CLI                          | Unchanged by design  | Applications consume the SDK, not a new CLI surface.                                                                          |
| Gantry MCP tools/admin skill | Unchanged by design  | This is an application integration API, not an agent tool.                                                                    |
| Channel/provider adapters    | Read-only/observable | The existing app channel emits outbound/streaming events consumed by the new route.                                           |
| Docs/prompts                 | Changed              | This contract and SDK changelog document the surface.                                                                         |
| Audit/events                 | Read-only/observable | Existing durable events are exposed without adding a parallel event vocabulary.                                               |
| Tests/verification           | Changed              | Filter validation, OpenAPI generation, SDK build, and type checks cover the contract.                                         |

Cleanup search terms: `AgentTenderSidecarClient`, `GANTRY_RUNTIME_DATABASE_URL`, callback endpoints, polling loops, and direct runtime-store access from application packages.
