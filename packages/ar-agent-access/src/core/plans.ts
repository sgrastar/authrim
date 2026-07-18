import type { JsonObject } from './types';

export type AgentPlanStatus = 'draft' | 'ready' | 'running' | 'completed' | 'failed';
export type AgentPlanStage = 'validate' | 'apply' | 'verify';

export interface AgentPlanStep {
  id: string;
  operation: string;
  input: JsonObject;
  schemaVersion: string;
}

export interface AgentPlanContract {
  id: string;
  tenantId: string;
  grantId: string;
  actorSub: string;
  version: number;
  digest: string;
  status: AgentPlanStatus;
  stage: AgentPlanStage;
  steps: readonly AgentPlanStep[];
  appliedStepCount: number;
  failedStepId?: string;
  failureKind?: string;
  expiresAt: number;
  cancelledAt?: number;
}
