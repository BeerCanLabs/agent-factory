import { useAuth } from './CloudflareAuth.js';

export function usePermissions() {
  const { hasRole } = useAuth();

  return {
    canWake: hasRole('operator'),
    canSleep: hasRole('operator'),
    canPause: hasRole('operator'),
    canResume: hasRole('operator'),
    canReset: hasRole('operator'),
    canDispatchPrompt: hasRole('operator'),
    canSwitchModel: hasRole('operator'),
    canApproveTool: hasRole('approver'),
    canDeploy: hasRole('admin'),
    canSetBudget: hasRole('admin'),
    canSetPolicy: hasRole('admin'),
    canSetOwners: hasRole('admin'),
    canQuarantine: hasRole('admin'),
    canRetire: hasRole('admin'),
    canPurge: hasRole('admin'),
    canApproveModel: hasRole('admin'),
    canManageCredentials: hasRole('admin'),
    canDecideSkills: hasRole('admin'),
    canManageIdentities: hasRole('admin'),
  };
}
