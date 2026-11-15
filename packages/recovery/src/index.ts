import { ElvionError } from '@elvion/kernel';
export type RecoveryDecision = 'retry'|'repair'|'stop'|'review';
export function recoveryDecision(error: unknown, state: {retries:number;repairs:number;sideEffectUncertain?:boolean}): RecoveryDecision {
  if (!Number.isSafeInteger(state.retries) || state.retries < 0 || !Number.isSafeInteger(state.repairs) || state.repairs < 0) return 'stop';
  if (state.sideEffectUncertain) return 'review';
  if (!(error instanceof ElvionError)) return 'stop';
  if (['cancelled','permission_denied','approval_required','timeout','budget_exceeded'].includes(error.code)) return 'stop';
  if (error.code === 'verification_failed') return state.repairs < 2 ? 'repair' : 'stop';
  return error.code === 'model_error' && error.retryable && state.retries < 2 ? 'retry' : 'stop';
}
