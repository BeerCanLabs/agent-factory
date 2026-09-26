import { useAuth } from './CloudflareAuth.js';

export function usePermissions() {
  const { hasRole } = useAuth();

  return {
    canWake: hasRole('operator'),
    canSleep: hasRole('operator'),
    canPause: hasRole('operator'),
    canResume: hasRole('operator'),
    canDispatchPrompt: hasRole('operator'),
    canSwitchModel: hasRole('operator'),
    canApproveTool: hasRole('approver'),
    canDeploy: hasRole('admin'),
    canSetBudget: hasRole('admin'),
    canQuarantine: hasRole('admin'),
    canRetire: hasRole('admin'),
    canPurge: hasRole('admin'),
    canApproveModel: hasRole('admin'),
  };
}
