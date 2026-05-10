import { z } from 'zod';

import {
  ContractMetadataSchema,
  ExternalReferenceSchema,
  IsoDateTimeSchema,
} from '../contract-primitives.js';

export const BrowserProfileStatusSchema = z.enum([
  'active',
  'inactive',
  'disabled',
  'archived',
]);
export type BrowserProfileStatus = z.infer<typeof BrowserProfileStatusSchema>;

export const BrowserProfileResponseSchema = z.object({
  id: z.string(),
  appId: z.string(),
  agentId: z.string().nullable().optional(),
  name: z.string(),
  status: BrowserProfileStatusSchema,
  stateRef: z.string().nullable().optional(),
  authMarkers: z.array(z.string()).optional(),
  usagePolicyRef: z.string().nullable().optional(),
  externalRef: ExternalReferenceSchema.optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  metadata: ContractMetadataSchema.optional(),
});
export type BrowserProfileResponse = z.infer<
  typeof BrowserProfileResponseSchema
>;

export const BROWSER_BACKEND_TOOL_NAMES = [
  'browser_status',
  'browser_launch',
  'browser_close',
  'browser_click',
  'browser_console_messages',
  'browser_drag',
  'browser_drop',
  'browser_evaluate',
  'browser_file_upload',
  'browser_fill_form',
  'browser_handle_dialog',
  'browser_hover',
  'browser_navigate',
  'browser_navigate_back',
  'browser_network_requests',
  'browser_press_key',
  'browser_resize',
  'browser_select_option',
  'browser_snapshot',
  'browser_take_screenshot',
  'browser_tabs',
  'browser_type',
  'browser_wait_for',
] as const;

export const BROWSER_IPC_ACTIONS = BROWSER_BACKEND_TOOL_NAMES;

export const BrowserIpcActionSchema = z.enum(BROWSER_IPC_ACTIONS);
export type BrowserIpcAction = (typeof BROWSER_IPC_ACTIONS)[number];

export const BrowserIpcRequestSchema = z.object({
  requestId: z.string(),
  action: BrowserIpcActionSchema,
  payload: ContractMetadataSchema.optional(),
  context: ContractMetadataSchema.optional(),
});
export type BrowserIpcRequest = z.infer<typeof BrowserIpcRequestSchema>;

export const BrowserIpcResponseSchema = z.object({
  ok: z.boolean(),
  requestId: z.string(),
  provider: z.string().optional(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type BrowserIpcResponse = z.infer<typeof BrowserIpcResponseSchema>;
