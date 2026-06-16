import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIpcResponseSigningKeyPair,
  verifyIpcResponsePayload,
} from '@core/infrastructure/ipc/response-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';

import {
  processPermissionIpcRequest,
  processUserQuestionIpcRequest,
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from '@core/runtime/ipc-interaction-handler.js';
import { processPermissionInteractionIpc } from '@core/runtime/ipc-interaction-processing.js';
import {
  clearIpcResponders,
  registerIpcResponder,
  takeIpcResponder,
} from '@core/runtime/ipc-response-router.js';

function createEmptyJobRepository() {
  return {
    listJobs: vi.fn(async () => []),
    getJobById: vi.fn(async () => null),
    updateJob: vi.fn(async () => null),
  };
}

describe('ipc-interaction-handler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-interaction-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    clearIpcResponders();
    vi.clearAllMocks();
  });

  it('delegates permission decisions through the domain handler', async () => {
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'reviewer',
      reason: 'safe',
    }));

    const response = await processPermissionIpcRequest(
      {
        requestId: 'perm-1',
        sourceAgentFolder: 'main',
        toolName: 'tool-x',
      },
      { requestPermissionApproval },
    );

    expect(response).toEqual({
      approved: true,
      decidedBy: 'reviewer',
      reason: 'safe',
    });
    expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
  });

  it('delegates user questions through the domain handler', async () => {
    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'q-1',
      answers: { mode: 'trigger' },
      answeredBy: 'human',
    }));

    const response = await processUserQuestionIpcRequest(
      {
        requestId: 'q-1',
        sourceAgentFolder: 'main',
        questions: [
          {
            header: 'Mode',
            question: 'Pick one',
            options: [
              { label: 'Trigger', description: 'Use trigger mode' },
              { label: 'Always', description: 'Use always mode' },
            ],
            multiSelect: false,
          },
        ],
      },
      { requestUserAnswer },
    );

    expect(response).toEqual({
      requestId: 'q-1',
      answers: { mode: 'trigger' },
      answeredBy: 'human',
    });
    expect(requestUserAnswer).toHaveBeenCalledTimes(1);
  });

  it('delivers signed permission responses to registered socket responders', () => {
    const keys = createIpcResponseSigningKeyPair();
    const delivered: Array<Record<string, unknown>> = [];
    registerIpcResponder('grp', 'permission-perm-2', (signed) => {
      delivered.push(signed);
    });

    writePermissionIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'perm-2',
        approved: false,
        reason: 'denied',
      },
      keys.privateKeyPem,
    );

    expect(delivered).toHaveLength(1);
    const payload = delivered[0];
    expect(payload).toMatchObject({
      requestId: 'perm-2',
      approved: false,
      reason: 'denied',
    });
    expect(
      verifyIpcResponsePayload(
        keys.publicKeyPem,
        { requestId: 'perm-2', approved: false, reason: 'denied' },
        payload.signature,
      ),
    ).toBe(true);
  });

  it('writes persistent permission metadata for runner SDK responses', () => {
    const keys = createIpcResponseSigningKeyPair();
    const delivered: Array<Record<string, unknown>> = [];
    registerIpcResponder('grp', 'permission-perm-3', (signed) => {
      delivered.push(signed);
    });

    writePermissionIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'perm-3',
        approved: true,
        mode: 'allow_persistent_rule',
        reason: 'persistent tool allowed',
        updatedPermissions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
          },
        ],
        decisionClassification: 'user_permanent',
      },
      keys.privateKeyPem,
    );

    expect(delivered).toHaveLength(1);
    const payload = delivered[0];
    expect(payload).toMatchObject({
      requestId: 'perm-3',
      approved: true,
      mode: 'allow_persistent_rule',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
        },
      ],
      decisionClassification: 'user_permanent',
    });
  });

  it('routes a permission response to a registered responder and writes no file (Pillar 1)', () => {
    const keys = createIpcResponseSigningKeyPair();
    const delivered: Array<Record<string, unknown>> = [];
    // The socket dispatcher registers this responder keyed by permission-<id>.
    registerIpcResponder('grp', 'permission-perm-routed', (signed) => {
      delivered.push(signed);
    });

    writePermissionIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'perm-routed',
        responseNonce: 'nonce-r',
        approved: true,
        mode: 'allow_once',
        decidedBy: 'reviewer',
      },
      keys.privateKeyPem,
    );

    // The signed payload was handed to the responder — and is the EXACT object
    // the fs file would contain (verifiable with the public key).
    expect(delivered).toHaveLength(1);
    const { signature, ...payloadWithoutSig } = delivered[0] as {
      signature?: string;
    } & Record<string, unknown>;
    expect(typeof signature).toBe('string');
    expect(
      verifyIpcResponsePayload(
        keys.publicKeyPem,
        payloadWithoutSig,
        signature as string,
      ),
    ).toBe(true);
    expect(payloadWithoutSig).toMatchObject({
      requestId: 'perm-routed',
      responseNonce: 'nonce-r',
      approved: true,
      mode: 'allow_once',
      decidedBy: 'reviewer',
    });

    // No permission-responses file was written — the responder consumed it, and
    // the responder is single-shot (now taken).
    const responsePath = path.join(
      tempDir,
      'grp',
      'permission-responses',
      'perm-routed.json',
    );
    expect(fs.existsSync(responsePath)).toBe(false);
    expect(takeIpcResponder('grp', 'permission-perm-routed')).toBeUndefined();
  });

  it('fail-closed (no signing key) leaves the permission responder registered to time out (Pillar 1)', () => {
    const delivered: Array<Record<string, unknown>> = [];
    registerIpcResponder('grp', 'permission-perm-nokey', (signed) => {
      delivered.push(signed);
    });

    // No signing key → withSignature returns null → the writer returns BEFORE
    // taking the responder (mirrors the user_question/memory writers). Nothing
    // is delivered and nothing is written; the responder is still registered so
    // the socket dispatcher's fail-closed guard settles the request.
    writePermissionIpcResponse(
      tempDir,
      'grp',
      { requestId: 'perm-nokey', approved: false, reason: 'denied' },
      undefined,
    );

    expect(delivered).toHaveLength(0);
    const responsePath = path.join(
      tempDir,
      'grp',
      'permission-responses',
      'perm-nokey.json',
    );
    expect(fs.existsSync(responsePath)).toBe(false);
    // Responder NOT taken — left registered to time out.
    expect(takeIpcResponder('grp', 'permission-perm-nokey')).toBeTypeOf(
      'function',
    );
  });

  it('writes persistent SDK permission approvals to the active run live-rule file', async () => {
    const toolRepository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__gantry__service_restart',
        appId: 'app:test',
        status: 'active',
        selectable: true,
      })),
      listTools: vi.fn(async () => []),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-live-admin',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce',
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        targetJid: 'tg:team',
        toolName: 'mcp__gantry__service_restart',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'mcp__gantry__service_restart' }],
            },
          ],
        })),
        sendMessage,
        opsRepository: createEmptyJobRepository() as never,
        getToolRepository: () => toolRepository as never,
        mirrorAgentToolRulesToSettings,
      },
      ipcBaseDir: tempDir,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            tempDir,
            'main_agent',
            'live-tool-rules',
            'agent-run-1.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual(['mcp__gantry__service_restart']);
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['mcp__gantry__service_restart'],
      { appId: 'app:test' },
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:team',
      expect.stringContaining('Always allowed:'),
      expect.any(Object),
    );
  });

  it('records persistent approvals at parent conversation scope while routing the receipt to the thread', async () => {
    const saveDecision = vi.fn(async () => undefined);
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => undefined);
    const toolRepository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__gantry__service_restart',
        appId: 'app:test',
        status: 'active',
        selectable: true,
      })),
      listTools: vi.fn(async () => []),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-thread-admin',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce',
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-thread',
        targetJid: 'tg:team',
        threadId: 'topic-7',
        toolName: 'mcp__gantry__service_restart',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner',
          reason: 'persistent tool allowed',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'mcp__gantry__service_restart' }],
            },
          ],
        })),
        sendMessage,
        publishRuntimeEvent,
        opsRepository: createEmptyJobRepository() as never,
        getToolRepository: () => toolRepository as never,
        getPermissionRepository: () =>
          ({
            savePolicy: vi.fn(),
            saveRule: vi.fn(),
            saveDecision,
            getDecision: vi.fn(),
          }) as never,
        mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
      },
      ipcBaseDir: tempDir,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    const savedDecision = saveDecision.mock.calls[0]?.[0];
    expect(savedDecision.actorContext).toMatchObject({
      requestId: 'perm-thread-admin',
      conversationId: 'tg:team',
      mode: 'allow_persistent_rule',
      classification: 'user_permanent',
    });
    expect(savedDecision.actorContext).not.toHaveProperty('threadId');
    const persistedEvent = publishRuntimeEvent.mock.calls
      .map((call) => call[0])
      .find((event) => event.eventType === 'permission.persisted');
    expect(persistedEvent).toEqual(
      expect.objectContaining({
        conversationId: 'tg:team',
        threadId: undefined,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:team',
      expect.stringContaining('Always allowed:'),
      { threadId: 'topic-7' },
    );
  });

  it('persists skill action capability approvals and appends runtime command rules', async () => {
    const skillCapability = {
      capabilityId: 'skill.linkedin-posting.publish',
      displayName: 'LinkedIn posting',
      category: 'LinkedIn posting',
      risk: 'write' as const,
      can: 'Publish posts through the selected LinkedIn posting skill.',
      cannot:
        'Use unrelated skills, credentials, settings, or broader commands.',
      credentialSource: 'skill_secret' as const,
      implementationBindings: [
        {
          kind: 'tool_rule' as const,
          rule: 'RunCommand(skills/linkedin-posting/publish *)',
        },
      ],
      preflight: { kind: 'none' as const },
      sandboxProfile: {
        network: 'required' as const,
        filesystem: 'workspace_write' as const,
      },
    };
    const toolRepository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-skill-action',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce',
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-skill',
        targetJid: 'tg:team',
        toolName: 'RunCommand',
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
          },
        ],
        semanticCapabilityDefinitions: {
          'skill.linkedin-posting.publish': skillCapability,
        },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_persistent_rule',
          decidedBy: 'owner',
          decisionClassification: 'user_permanent',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [
                { toolName: 'capability:skill.linkedin-posting.publish' },
              ],
            },
          ],
        })),
        opsRepository: createEmptyJobRepository() as never,
        getToolRepository: () => toolRepository as never,
        mirrorAgentToolRulesToSettings,
      },
      ipcBaseDir: tempDir,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(toolRepository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool:capability:skill.linkedin-posting.publish',
        name: 'capability:skill.linkedin-posting.publish',
        displayName: 'LinkedIn posting',
      }),
    );
    expect(toolRepository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:test',
        toolId: 'tool:capability:skill.linkedin-posting.publish',
        status: 'active',
      }),
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['capability:skill.linkedin-posting.publish'],
      { appId: 'app:test' },
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            tempDir,
            'main_agent',
            'live-tool-rules',
            'agent-run-skill.json',
          ),
          'utf-8',
        ),
      ),
    ).toEqual([
      'capability:skill.linkedin-posting.publish',
      'RunCommand(skills/linkedin-posting/publish *)',
    ]);
  });

  it('strips live-rule updates from non-permanent permission IPC responses', async () => {
    const envelope = createIpcAuthEnvelope('main_agent', null);
    const delivered: Array<Record<string, unknown>> = [];
    registerIpcResponder('main_agent', 'permission-perm-once', (signed) => {
      delivered.push(signed);
    });

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-once',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce-once',
        responseKeyId: envelope.responseKeyId,
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-once',
        targetJid: 'tg:team',
        toolName: 'Bash',
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_once',
          decidedBy: 'owner',
          decisionClassification: 'user_temporary',
          updatedPermissions: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Bash', ruleContent: 'npm test' }],
            },
          ],
        })),
      },
      ipcBaseDir: tempDir,
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    });

    expect(delivered).toHaveLength(1);
    const response = delivered[0];
    expect(response).toMatchObject({
      requestId: 'perm-once',
      approved: true,
      mode: 'allow_once',
      decisionClassification: 'user_temporary',
    });
    expect(response.updatedPermissions).toBeUndefined();
    expect(
      fs.existsSync(
        path.join(
          tempDir,
          'main_agent',
          'live-tool-rules',
          'agent-run-once.json',
        ),
      ),
    ).toBe(false);
  });

  it('emits structured permission events and redacted Bash command telemetry', async () => {
    const publishRuntimeEvent = vi.fn(async () => undefined);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const command =
      'OPENAI_API_KEY=sk-ant-testtoken123456789012345 npm test -- --runInBand';

    await processPermissionInteractionIpc({
      request: {
        requestId: 'perm-bash-once',
        appId: 'app:test',
        agentId: 'agent:test',
        responseNonce: 'nonce',
        sourceAgentFolder: 'main_agent',
        runHandle: 'agent-run-1',
        runId: 'run:test',
        jobId: 'job:test',
        targetJid: 'tg:team',
        threadId: 'thread:test',
        toolName: 'Bash',
        toolInput: { command },
      },
      sourceAgentFolder: 'main_agent',
      deps: {
        requestPermissionApproval: vi.fn(async () => ({
          approved: true,
          mode: 'allow_once',
          decidedBy: 'owner',
          reason: 'safe for this run',
          decisionClassification: 'user_temporary',
        })),
        publishRuntimeEvent,
      },
      ipcBaseDir: tempDir,
      logger,
    });

    expect(
      publishRuntimeEvent.mock.calls.map((call) => call[0].eventType),
    ).toEqual([
      'permission.requested',
      'permission.allowed',
      'permission.resumed',
      'permission.final_outcome',
    ]);
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentId: 'agent:test',
        runId: 'run:test',
        jobId: 'job:test',
        conversationId: 'tg:team',
        threadId: 'thread:test',
        correlationId: 'perm-bash-once',
        payload: expect.objectContaining({
          toolName: 'Bash',
          canonicalCapability: 'Bash',
          commandPreview:
            'OPENAI_API_KEY=[REDACTED_SECRET] npm test -- --runInBand',
          commandHash: expect.any(String),
        }),
      }),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('sk-ant');
    expect(JSON.stringify(publishRuntimeEvent.mock.calls)).not.toContain(
      'sk-ant',
    );
  });

  it('sanitizes user answer keys and values when writing responses', () => {
    const keys = createIpcResponseSigningKeyPair();
    const delivered: Array<Record<string, unknown>> = [];
    registerIpcResponder('grp', 'userq-q-2', (signed) => {
      delivered.push(signed);
    });
    const answers = {
      mode: 'trigger',
      '': 'ignored',
      multi: ['a', 'b', 5, 'c'],
    } as unknown as Record<string, string | string[]>;

    writeUserQuestionIpcResponse(
      tempDir,
      'grp',
      {
        requestId: 'q-2',
        answers,
        answeredBy: 'user',
      },
      keys.privateKeyPem,
    );

    expect(delivered).toHaveLength(1);
    const payload = delivered[0];
    expect(payload).toMatchObject({
      requestId: 'q-2',
      answers: {
        mode: 'trigger',
        multi: ['a', 'b', 'c'],
      },
      answeredBy: 'user',
    });
  });
});
