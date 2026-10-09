import { z } from 'zod';

/**
 * The 11 canonical Factory Services (The Cast of Characters) defined in DESIGN_AUTHORITY.md §6.15.
 */
export const FACTORY_SERVICE_NAMES = [
  'gatekeeper',
  'keymaster',
  'executive',
  'secretary',
  'landlord',
  'auditor',
  'treasurer',
  'bouncer',
  'timekeeper',
  'registrar',
  'inspector',
] as const;

export type FactoryServiceName = (typeof FACTORY_SERVICE_NAMES)[number];

export const factoryServiceNameSchema = z.enum(FACTORY_SERVICE_NAMES);

export interface FactoryServiceMetadata {
  name: FactoryServiceName;
  title: string;
  role: string;
  hostedIn: readonly string[];
  /**
   * Repo-relative source files this member owns in the shared packages (SHARED_PACKAGES); a file several members list must be in SPLIT_FILES.
   * A file is a member's when its own code is in it; calling another member's contract does not make the caller a co-owner.
   */
  owns?: readonly string[];
}

export const FACTORY_SERVICES: Record<FactoryServiceName, FactoryServiceMetadata> = {
  gatekeeper: {
    name: 'gatekeeper',
    title: 'Gatekeeper',
    role: 'Perimeter defense, ingress presence, front-door authentication verification (A1, A2), wakes, and outbound routing with credential injection',
    hostedIn: ['packages/gatekeeper-ingress', 'packages/gatekeeper-egress', 'packages/auth', 'packages/control-plane'],
    owns: [
      'packages/control-plane/src/app.ts',
      'packages/control-plane/src/policy.ts',
      'packages/gatekeeper-egress/src/gatekeeper-egress.ts',
      'packages/gatekeeper-egress/src/main.ts',
    ],
  },
  keymaster: {
    name: 'keymaster',
    title: 'Keymaster',
    role: 'Credential facilitation, OAuth connection lifecycle, and vault mapping (K1–K5)',
    hostedIn: ['packages/keymaster', 'packages/secrets-bind', 'packages/control-plane', 'packages/gatekeeper-egress'],
    owns: [
      'packages/control-plane/src/app.ts',
      'packages/control-plane/src/connections.ts',
      'packages/control-plane/src/credentials.ts',
      'packages/gatekeeper-egress/src/signin-links.ts',
    ],
  },
  executive: {
    name: 'executive',
    title: 'Executive',
    role: 'Model service and uniform inference provider with token and cost metering (M1–M4, E5)',
    hostedIn: ['packages/gatekeeper-egress'],
    owns: [
      'packages/gatekeeper-egress/src/gatekeeper-egress.ts',
      'packages/gatekeeper-egress/src/meter.ts',
      'packages/gatekeeper-egress/src/models.ts',
      'packages/gatekeeper-egress/src/sigv4.ts',
    ],
  },
  secretary: {
    name: 'secretary',
    title: 'Secretary',
    role: 'State hydration and remote object storage synchronization (The Safe, §6.6)',
    hostedIn: ['packages/hydrate'],
  },
  landlord: {
    name: 'landlord',
    title: 'Landlord',
    role: 'Compute lifecycle management, wake-from-zero, warm-down, and turn mailbox delivery (L1–L6)',
    hostedIn: ['packages/control-plane'],
    owns: [
      'packages/control-plane/src/app.ts',
      'packages/control-plane/src/callbacks.ts',
      'packages/control-plane/src/queues.ts',
      'packages/control-plane/src/runs.ts',
      'packages/control-plane/src/runtime.ts',
      'packages/control-plane/src/runtime-docker.ts',
      'packages/control-plane/src/runtime-ecs.ts',
      'packages/control-plane/src/aws/codebuild.ts',
      'packages/control-plane/src/aws/deploy.ts',
      'packages/control-plane/src/aws/ecs.ts',
      'packages/control-plane/src/aws/gatekeeper-held.ts',
      'packages/control-plane/src/aws/iam.ts',
      'packages/control-plane/src/gcp/cloudbuild.ts',
      'packages/control-plane/src/gcp/cloudrun.ts',
      'packages/control-plane/src/gcp/deploy.ts',
      'packages/control-plane/src/gcp/iam.ts',
    ],
  },
  auditor: {
    name: 'auditor',
    title: 'Auditor',
    role: 'Immutable append-only WORM execution ledger and cryptographic non-repudiation (LG1, LG2)',
    hostedIn: ['packages/ledger', 'packages/control-plane'],
    owns: [
      'packages/control-plane/src/app.ts',
    ],
  },
  treasurer: {
    name: 'treasurer',
    title: 'Treasurer',
    role: 'Spend governance, real-time token pricing, and budget circuit-breakers (E5, M3)',
    hostedIn: ['packages/budget', 'packages/control-plane'],
    owns: [
      'packages/control-plane/src/app.ts',
      'packages/control-plane/src/spend.ts',
      'packages/control-plane/src/aws/treasurer.ts',
    ],
  },
  bouncer: {
    name: 'bouncer',
    title: 'Bouncer',
    role: 'Authorization (roles to privileges, owners, requesters) and human-in-the-loop approvals for sensitive held actions (E4, E9)',
    hostedIn: ['packages/bouncer', 'packages/control-plane'],
    owns: [
      'packages/control-plane/src/app.ts',
      'packages/control-plane/src/identity-links.ts',
    ],
  },
  timekeeper: {
    name: 'timekeeper',
    title: 'Timekeeper',
    role: 'Agent-scoped cron scheduling and one-shot wakeup timers (§6.15)',
    hostedIn: ['packages/control-plane', 'packages/timekeeper'],
    owns: ['packages/control-plane/src/schedules.ts'],
  },
  registrar: {
    name: 'registrar',
    title: 'Registrar',
    role: 'Agent record and registry, commit pinning and admission, skill registry and checks, and the deployment configuration store (L3, L4, SK1–SK5)',
    hostedIn: ['packages/contract', 'packages/control-plane', 'packages/registrar'],
    owns: [
      'packages/control-plane/src/app.ts',
      'packages/control-plane/src/aws/codebuild.ts',
      'packages/control-plane/src/config-store.ts',
      'packages/control-plane/src/skills.ts',
      'packages/control-plane/src/systems.ts',
    ],
  },
  inspector: {
    name: 'inspector',
    title: 'Inspector',
    role: 'Telemetry, live run progress event streaming, and error diagnosis (§6.5)',
    hostedIn: ['packages/inspector', 'packages/telemetry', 'packages/control-plane'],
    owns: [
      'packages/control-plane/src/app.ts',
      'packages/control-plane/src/progress-routes.ts',
      'packages/control-plane/src/stream.ts',
    ],
  },
};

/**
 * Declared platform tooling and non-service infrastructure roles.
 */
export const ALLOWED_PLATFORM_ROLES = [
  'operator-ui',
  'conformance-suite',
  'diagnostic-tool',
] as const;

export type PlatformRole = (typeof ALLOWED_PLATFORM_ROLES)[number];

export interface PackageClassification {
  services?: readonly FactoryServiceName[];
  platformRole?: PlatformRole;
  reservedFor?: FactoryServiceName;
}

/**
 * Packages whose source several members share (§6.15). Every non-test source file under their `src/` has an owner:
 * a member's `owns`, COMPOSITION_ROOT_FILES or PLATFORM_FILES. SV1 and `owns` must agree (a member that owns a file
 * in a package lists that package in `hostedIn`).
 */
export const SHARED_PACKAGES = ['packages/control-plane', 'packages/gatekeeper-egress'] as const;

/**
 * Files several members share until they are broken up (§6.15). The conformance test requires each to be claimed by
 * more than one member, and rejects a second claimant for any file not listed here.
 */
export const SPLIT_FILES: readonly string[] = [
  'packages/control-plane/src/app.ts',
  'packages/control-plane/src/aws/codebuild.ts',
  'packages/gatekeeper-egress/src/gatekeeper-egress.ts',
];

/** Entry points that wire the members together; they belong to no one member. */
export const COMPOSITION_ROOT_FILES: readonly string[] = [
  'packages/control-plane/src/index.ts',
  'packages/gatekeeper-egress/src/index.ts',
];

/** Operator-facing files in a shared package that serve a declared platform role rather than a member. */
export const PLATFORM_FILES: Record<string, PlatformRole> = {
  'packages/control-plane/src/ui.ts': 'operator-ui',
};

/**
 * Packages reserved for a service that do not host it yet.
 * Kept out of `hostedIn` so an empty directory cannot satisfy SV1.
 */
export const RESERVED_PACKAGES: Record<string, FactoryServiceName> = {};

/**
 * Declared non-service platform tooling packages.
 */
export const PLATFORM_TOOL_PACKAGES: Record<string, PlatformRole> = {
  bench: 'diagnostic-tool',
  conformance: 'conformance-suite',
  console: 'operator-ui',
};

/**
 * Derives the canonical package classification from FACTORY_SERVICES and PLATFORM_TOOL_PACKAGES.
 */
export function getPackageClassification(pkgName: string): PackageClassification | undefined {
  if (pkgName in PLATFORM_TOOL_PACKAGES) {
    return { platformRole: PLATFORM_TOOL_PACKAGES[pkgName] };
  }

  const pkgPath = `packages/${pkgName}`;
  const services: FactoryServiceName[] = [];

  for (const [serviceName, meta] of Object.entries(FACTORY_SERVICES)) {
    if (meta.hostedIn.includes(pkgPath)) {
      services.push(serviceName as FactoryServiceName);
    }
  }

  if (services.length > 0) {
    return { services };
  }

  if (pkgName in RESERVED_PACKAGES) {
    return { reservedFor: RESERVED_PACKAGES[pkgName] };
  }

  return undefined;
}
