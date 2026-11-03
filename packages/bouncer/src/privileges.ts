import type { Role } from '@beercanlabs/factory-auth';

/**
 * The privileges the control plane's routes ask for, one name per kind of action (the census in DESIGN_AUTHORITY.md,
 * work stream "Bouncer flow"). A route asks the Bouncer for one named privilege; it never names a role.
 */
export const PRIVILEGES = [
  'agents.read',
  'policy.read',
  'config.read',
  'runs.read',
  'ledger.read',
  'models.read',
  'metrics.read',
  'triage.read',
  'spend.read',
  'approvals.read',
  'skills.read',
  'skills.register',
  'systems.read',
  'systems.propose',
  'connections.read',
  'credentials.provider.read',
  'events.subscribe',
  'schedules.read',
  'mcp.use',
  'agents.wake',
  'agents.pause',
  'agents.resume',
  'agents.reset',
  'agents.isolate',
  'runs.cancel',
  'agents.converse',
  'schedules.write',
  'runs.attest-requester',
  'approvals.channel',
  'approvals.decide',
  'ledger.ingest',
  'ledger.attest-run-actor',
  'egress.run.read',
  'egress.approvals.request',
  'egress.holds.create',
  'egress.approvals.consume',
  'egress.keymaster.checkout',
  'egress.progress.report',
  'egress.routes.read',
  'egress.models.read',
  'egress.connections.token',
  'registry.register',
  'registry.budget.set',
  'registry.retire',
  'registry.reinstate',
  'registry.purge',
  'registry.deploy',
  'registry.model.set',
  'policy.set',
  'policy.budget.set',
  'config.export',
  'config.export.agent',
  'agents.owners.set',
  'identity.links.read',
  'identity.links.set',
  'credentials.outstanding.read',
  'credentials.platform.read',
  'credentials.platform.set',
  'credentials.agent.read',
  'credentials.agent.set',
  'credentials.provider.set',
  'connections.start',
  'connections.import',
  'systems.decide',
  'skills.decide',
  'skills.decide.private',
  'skills.checks.run',
  'skills.adopt.request',
  'skills.adopt.remove',
  'skills.adopt.decide',
  'skills.retire',
  'skills.training.fund',
  'skills.training.run',
  'agents.roles.read',
  'agents.settings.read',
  'agents.settings.set',
  'agents.create',
  'agents.roles.assign',
  'spend.budget.set',
  'agents.update.read',
  'agents.update.install',
  'models.manage',
  // AM5: read another person's conversations through the agent (the console resume of someone else's conversation).
  'conversations.read-others',
  // TSK-277 (Slice 3): Groups management (A8, A10)
  'groups.manage',
  // TSK-277 (Slice 3b): Scoped skill privileges and administration (A8, A9, A17)
  'skills.version.add',
  'skills.assign',
  'skills.package.read',
  'skills.transfer',
  // TSK-278 (Slice 4): Publishing workflow and retirement (H8, H9, A8, A9, A13)
  'skills.publish.request',
  'skills.unpublish',
  'skills.retire.force',
  // TSK-280: Admin-approved runtime rollout (RT1, GAP-206)
  'runtime.set',
  // TSK-165 (Slice 1): Model selection and failback
  'agents.models.read',
  'agents.models.set',
  'egress.models.failover',
  // TSK-292: Admin-managed default skills (GAP-216)
  'skills.defaults.set',
  // TSK-300 (S3): Principals & grants management (R4, GAP-226)
  'grants.manage',
  // S4 (D27): the content admission gate decision, the approver role's one privilege beyond reads.
  'content.admit',
  // S19 (D25): allocate AI model budget to an agent, outside submission. Held by `budget-owner` and `admin`.
  'budget.allocate',
  // S20 (D27): submit an agent or skill draft. Any signed-in user with a fleet role.
  'content.submit',
] as const;

export type Privilege = (typeof PRIVILEGES)[number];

/**
 * Role to privileges, in full. Users map to roles and roles map to privileges, never a user to a privilege.
 * Built into the code (Dale, 2026-10-03); making it factory data an admin edits is a later enhancement, so read
 * this table only through `authorize`: never import it elsewhere.
 */
export const ROLE_PRIVILEGES: Record<Role, readonly Privilege[]> = {
  // Reads. An operator and an approver also hold every viewer privilege.
  viewer: [
    'agents.read',
    'agents.models.read',
    'policy.read',
    'config.read',
    'runs.read',
    'ledger.read',
    'models.read',
    'metrics.read',
    'triage.read',
    'spend.read',
    'approvals.read',
    'skills.read',
    'systems.read',
    'systems.propose',
    'connections.read',
    'credentials.provider.read',
    'events.subscribe',
    'schedules.read',
    'mcp.use',
    'content.submit',
  ],
  operator: [
    'agents.read',
    'agents.models.read',
    'policy.read',
    'config.read',
    'runs.read',
    'ledger.read',
    'models.read',
    'metrics.read',
    'triage.read',
    'spend.read',
    'approvals.read',
    'skills.read',
    'systems.read',
    'systems.propose',
    'connections.read',
    'credentials.provider.read',
    'events.subscribe',
    'schedules.read',
    'mcp.use',
    'content.submit',
    'agents.wake',
    'agents.pause',
    'agents.resume',
    'agents.reset',
    'agents.isolate',
    'runs.cancel',
    'agents.converse',
    'schedules.write',
    'agents.update.read',
    'agents.create',
  ],
  approver: [
    'agents.read',
    'agents.models.read',
    'policy.read',
    'config.read',
    'runs.read',
    'ledger.read',
    'models.read',
    'metrics.read',
    'triage.read',
    'spend.read',
    'approvals.read',
    'skills.read',
    'systems.read',
    'systems.propose',
    'connections.read',
    'credentials.provider.read',
    'events.subscribe',
    'schedules.read',
    'mcp.use',
    'content.submit',
    // S4, D27, D29: approver is the admission gate only; run-time holds go to the content side.
    'content.admit',
  ],
  ingest: [
    'ledger.ingest',
  ],
  // The egress holds the ingest privileges too. Two of these are exclusive: an admin does not hold them.
  'gatekeeper-egress': [
    'ledger.ingest',
    'ledger.attest-run-actor',
    'egress.run.read',
    'egress.approvals.request',
    'egress.holds.create',
    'egress.approvals.consume',
    'egress.keymaster.checkout',
    'egress.progress.report',
    'egress.routes.read',
    'egress.models.read',
    'egress.connections.token',
    'egress.models.failover',
  ],
  // The ingress is the one party that sees who sent a message, so it alone may say who asked (Dale, 2026-10-04: an
  // operator or admin must not be able to name the requester). Its token also carries `operator`, which it needs to
  // wake agents and hand off messages.
  'gatekeeper-ingress': [
    'runs.attest-requester',
    'approvals.channel',
  ],
  // Everything except the exclusive privileges.
  admin: [
    'agents.read',
    'agents.models.read',
    'agents.models.set',
    'policy.read',
    'config.read',
    'runs.read',
    'ledger.read',
    'models.read',
    'metrics.read',
    'triage.read',
    'spend.read',
    'approvals.read',
    'skills.read',
    'skills.register',
    'systems.read',
    'systems.propose',
    'connections.read',
    'credentials.provider.read',
    'events.subscribe',
    'schedules.read',
    'mcp.use',
    'content.submit',
    'agents.wake',
    'agents.pause',
    'agents.resume',
    'agents.reset',
    'agents.isolate',
    'runs.cancel',
    'agents.converse',
    'schedules.write',
    'approvals.decide',
    'ledger.ingest',
    'egress.run.read',
    'egress.approvals.request',
    'egress.holds.create',
    'egress.approvals.consume',
    'egress.keymaster.checkout',
    'egress.progress.report',
    'egress.routes.read',
    'egress.models.read',
    'registry.register',
    'registry.budget.set',
    'registry.retire',
    'registry.reinstate',
    'registry.purge',
    'registry.deploy',
    'registry.model.set',
    'policy.set',
    'policy.budget.set',
    'config.export',
    'config.export.agent',
    'agents.owners.set',
    'identity.links.read',
    'identity.links.set',
    'credentials.outstanding.read',
    'credentials.platform.read',
    'credentials.platform.set',
    'credentials.agent.read',
    'credentials.agent.set',
    'credentials.provider.set',
    'connections.start',
    'connections.import',
    'systems.decide',
    'skills.decide',
    'skills.decide.private',
    'skills.checks.run',
    'skills.adopt.request',
    'skills.adopt.remove',
    'skills.adopt.decide',
    'skills.retire',
    'skills.training.fund',
    'skills.training.run',
    'agents.roles.read',
    'agents.settings.read',
    'agents.settings.set',
    'agents.create',
    'agents.roles.assign',
    'spend.budget.set',
    'agents.update.read',
    'agents.update.install',
    'models.manage',
    'conversations.read-others',
    'groups.manage',
    'skills.version.add',
    'skills.assign',
    'skills.package.read',
    'skills.transfer',
    'skills.publish.request',
    'skills.unpublish',
    'skills.retire.force',
    'runtime.set',
    'skills.defaults.set',
    'grants.manage',
    'content.admit',
    'budget.allocate',
  ],
};

/**
 * S19 (D7, D25): fleet roles that exist only as grants (not as credential roles). `budget-owner` is a grantor that
 * allocates AI model budget and reads what it needs to; it admits nothing and edits nothing else.
 */
export const FLEET_GRANT_ROLE_PRIVILEGES: Readonly<Record<'budget-owner', readonly Privilege[]>> = {
  'budget-owner': ['agents.read', 'spend.read', 'policy.read', 'budget.allocate'],
};

/**
 * Privileges that act on one agent, so a route can pass that agent as the resource. Only these can be held through
 * ownership or as the requester; every other privilege is fleet-wide and is held by roles alone.
 */
export const AGENT_SCOPED: ReadonlySet<Privilege> = new Set<Privilege>([
  'agents.wake',
  'agents.pause',
  'agents.resume',
  'agents.models.read',
  'agents.models.set',
  'config.read',
  'config.export.agent',
  'credentials.agent.read',
  'credentials.agent.set',
  'connections.start',
  'connections.import',
  'skills.adopt.request',
  'skills.adopt.remove',
  'skills.decide.private',
  'skills.training.fund',
  'skills.training.run',
  'agents.roles.read',
  'agents.settings.read',
  'agents.settings.set',
  'agents.roles.assign',
  'approvals.decide',
  // E12: a person who holds an agent role may start a run and converse, so a message can reach the agent they hold it on.
  'agents.converse',
  'agents.update.read',
  'agents.update.install',
]);

/** The roles that are derived from data about one agent, skill, or run, never read from a credential or a claim. */
export type DerivedRole =
  | 'agent-owner'
  | 'agent-member'
  | 'requester'
  | 'skill-owner'
  | 'content-owner'
  | 'content-owner-readonly'
  | 'accountable-lead'
  | 'team-member';

/**
 * Privileges that act on one skill, so a route can pass that skill as the resource.
 * These can be held through skill ownership or group membership (A8, A9, H5).
 */
export const SKILL_SCOPED: ReadonlySet<Privilege> = new Set<Privilege>([
  'skills.version.add',
  'skills.retire',
  'skills.assign',
  'skills.package.read',
  'skills.transfer',
  'skills.publish.request',
  'skills.unpublish',
]);

/** Read-only skill privileges retained by an outgoing skill `content-owner` while a transfer is `pending-revoked` (D15). */
export const SKILL_CONTENT_OWNER_READONLY_PRIVILEGES: readonly Privilege[] = ['skills.package.read'];

/**
 * What a derived role holds, on its own agent or skill only (Dale, 2026-10-03, A9, D7, D11, D15, D24, D29, S2b).
 * `approvals.decide` is held by a legacy `agent-owner` only when the run has no requesting user (see `authorize`),
 * whereas grant-backed personal `content-owner` and team `accountable-lead` / `team-member` hold `approvals.decide`
 * per D29 (personal `agent-member` sub-roles never hold `approvals.decide`).
 */
export const DERIVED_ROLE_PRIVILEGES: Record<DerivedRole, readonly Privilege[]> = {
  'agent-owner': [
    'agents.models.read',
    'agents.models.set',
    'config.read',
    'config.export.agent',
    'credentials.agent.read',
    'credentials.agent.set',
    'connections.start',
    'connections.import',
    'agents.wake',
    'agents.pause',
    'agents.resume',
    'skills.adopt.request',
    'skills.adopt.remove',
    'skills.decide.private',
    'skills.training.fund',
    'skills.training.run',
    'agents.roles.read',
    'agents.settings.read',
    'agents.settings.set',
    'agents.roles.assign',
    'approvals.decide',
    'agents.update.read',
    'agents.update.install',
  ],
  /**
   * D7, D11, D24, D29: Grant-backed sole `content-owner` on a `personal` agent. Holds full personal-agent management,
   * wake + converse, and run-time hold clearance (`approvals.decide`).
   */
  'content-owner': [
    'agents.models.read',
    'agents.models.set',
    'config.read',
    'config.export.agent',
    'credentials.agent.read',
    'credentials.agent.set',
    'connections.start',
    'connections.import',
    'agents.wake',
    'agents.converse',
    'agents.pause',
    'agents.resume',
    'skills.adopt.request',
    'skills.adopt.remove',
    'skills.decide.private',
    'skills.training.fund',
    'skills.training.run',
    'agents.roles.read',
    'agents.settings.read',
    'agents.settings.set',
    'agents.roles.assign',
    'approvals.decide',
    'agents.update.read',
    'agents.update.install',
  ],
  /**
   * D15: Outgoing personal-agent `content-owner` while an ownership transfer is in `pending-revoked`.
   * Strictly non-secret read-only inspection; zero mutations, zero bundle export, zero wake/converse/hold clearance.
   */
  'content-owner-readonly': [
    'agents.models.read',
    'config.read',
    'credentials.agent.read',
    'agents.roles.read',
    'agents.settings.read',
    'agents.update.read',
  ],
  /**
   * D11, D24, D26, D29: `accountable-lead` on a `team` agent. Manages team configuration, models, credentials,
   * skills, settings, updates, and `member` grants (`agents.roles.assign`), wakes/converses, and clears holds,
   * without personal-owner bundle export or personal user-OAuth binding.
   */
  'accountable-lead': [
    'agents.models.read',
    'agents.models.set',
    'config.read',
    'credentials.agent.read',
    'credentials.agent.set',
    'agents.wake',
    'agents.converse',
    'agents.pause',
    'agents.resume',
    'skills.adopt.request',
    'skills.adopt.remove',
    'skills.decide.private',
    'skills.training.fund',
    'skills.training.run',
    'agents.roles.read',
    'agents.settings.read',
    'agents.settings.set',
    'agents.roles.assign',
    'approvals.decide',
    'agents.update.read',
    'agents.update.install',
  ],
  /**
   * D11, D29, S2b: `member` grant on a `team` agent — wakes, converses, and clears run-time holds on that team agent.
   */
  'team-member': ['agents.wake', 'agents.converse', 'approvals.decide'],
  /**
   * E12 (Dale, 2026-10-10), D29: a person who holds an agent sub-role on a personal agent (Stephanie: `Family` on Donna)
   * may reach that agent, and nothing else: start a run and converse. Never clears holds (`approvals.decide`).
   */
  'agent-member': ['agents.wake', 'agents.converse'],
  // S22, D29: the requester no longer clears holds; the derived role stays for its other uses and holds nothing here.
  requester: [],
  /**
   * A9: Built-in `skill-owner` role. It carries `skills.version.add`, `skills.retire`, `skills.assign`,
   * `skills.publish.request`, `skills.unpublish`, and `skills.package.read`, and not `skills.transfer`.
   */
  'skill-owner': [
    'skills.version.add',
    'skills.retire',
    'skills.assign',
    'skills.publish.request',
    'skills.unpublish',
    'skills.package.read',
  ],
};
