import type { PermissionDecision } from '../../domain/permissions/permissions.js';
import { ApplicationError } from '../common/application-error.js';

export class EvaluateToolActionUseCase {
  async execute(input: { action: Record<string, unknown> }): Promise<{
    decision: PermissionDecision;
  }> {
    const actionType =
      typeof input.action.type === 'string' ? input.action.type : 'unknown';
    throw new ApplicationError(
      'UNAVAILABLE',
      'Tool action evaluation requires a permission policy repository before decisions can be produced.',
      { details: [`actionType=${actionType}`] },
    );
  }
}
