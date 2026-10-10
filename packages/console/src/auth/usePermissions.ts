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
    // SK3, SK6: an adoption adds access, so an admin decides it; retiring a skill reaches every agent that runs it.
    canDecideAdoptions: hasRole('admin'),
    canRetireSkills: hasRole('admin'),
    canManageIdentities: hasRole('admin'),
  };
}
