export type { Approval, ApprovalState, ChangeRequest, ChannelAsk, HeldRequest } from './approvals.js';
export { ApprovalStore, CHANNEL_ASK_TTL_MS } from './approvals.js';
export type { ApprovalOutcome, ApprovalRequest, HoldOutcome, HoldRequest } from './wire.js';
export { HELD_BODY_LIMIT, HELD_HEADERS, HELD_STORED_BODY_LIMIT } from './wire.js';
export type { DescribedHold, ParsedHold } from './hold.js';
export { describeHeldRequest, heldCopyOf, heldToolName, parseHoldRequest } from './hold.js';
export type { HoldCheck, HoldDecision, HoldRule, ToolApprovalCheck, ToolApprovalDecision } from './decisions.js';
export { checkHold, checkToolApproval } from './decisions.js';
export type { DerivedRole, Privilege } from './privileges.js';
export { PRIVILEGES, AGENT_SCOPED } from './privileges.js';
export type { AuthorizeRequest, AuthorizeResource, AuthorizeResult } from './authorize.js';
export { authorize } from './authorize.js';
export type {
  AuthenticatedCaller,
  ExternalIdentity,
  IdentityLink,
  IdentityProvider,
  IngressAuthorizeRequest,
  IngressAuthorizeResult,
} from './identity.js';
export {
  IdentityLinkStore,
  PRINCIPAL_ACTOR,
  PROVIDERS,
  authorizeIngress,
  directCaller,
  isProvider,
  normalizeActorToPrincipal,
  normalizeGroupMembersToPrincipals,
  normalizeIdentityLink,
  normalizeLegacyActor,
  normalizeOwnersToPrincipals,
  parseActor,
  sanitizeAgentRoles,
} from './identity.js';
export type {
  AwsCliRunner,
  CreatePrincipalInput,
  GcsDocBackendOptions,
  IdpBinding,
  PrincipalRecord,
  PrincipalsDoc,
  RecordSignInInput,
  RecordSignInResult,
  VersionedDocBackend,
  VersionedLoadState,
  VersionedSnapshot,
} from './principals.js';
export {
  DuplicatePrincipalEmailError,
  DuplicatePrincipalIdError,
  EMAIL_DOMAIN_BODY,
  FileDocBackend,
  GcsDocBackend,
  MemoryDocBackend,
  PRINCIPAL_ID,
  PrincipalStore,
  PrincipalStoreUnavailableError,
  S3CliDocBackend,
  SERVICE_PRINCIPAL_ID,
  deriveSlugFromEmail,
  docBackendFromUri,
  isValidUserPrincipalId,
  normalizeDomain,
  normalizeEmail,
  snapshotSha256,
} from './principals.js';
export type {
  AgentBuiltInRole,
  CreateGrantInput,
  EffectiveGrant,
  EffectiveGrantQuery,
  EvaluateEffectiveGrantsResult,
  FleetGrantRole,
  FleetHumanRole,
  FleetServiceRole,
  GrantErrorCode,
  GrantRecord,
  GrantScope,
  GrantState,
  GrantStoreOptions,
  GrantSubjectKind,
  GrantsDoc,
  KnownGroupsCheck,
  MaterializeSignInInput,
  MaterializeSignInResult,
  ResolveOwnershipTransferInput,
  RevokeGrantOptions,
  SkillGrantRole,
  StartOwnershipTransferInput,
  UpdateGrantInput,
} from './grants.js';
export {
  AGENT_BUILTIN_ROLES,
  DEFAULT_TRANSFER_TTL_MS,
  DOMAIN_SUBJECT,
  FLEET_HUMAN_ROLES,
  FLEET_SERVICE_ROLES,
  GRANT_STATES,
  GRANT_SUBJECT,
  GROUP_SUBJECT,
  GrantStore,
  GrantStoreError,
  GrantStoreUnavailableError,
  SKILL_GRANT_ROLES,
  normalizeGrantScope,
  normalizeGroupSubjectId,
  parseGrantSubject,
  parseIsoTimestamp,
} from './grants.js';
