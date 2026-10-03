import { z } from 'zod';

/**
 * The 11 canonical Factory Services (The Cast of Characters) defined in DESIGN_AUTHORITY.md §6.15.
 */
export const FACTORY_SERVICE_NAMES = [
  'gatekeeper',
  'keymaster',
  'tinman',
  'secretary',
  'landlord',
  'auditor',
  'treasurer',
  'bouncer',
  'timekeeper',
  'registrar',
  'seer',
] as const;

export type FactoryServiceName = (typeof FACTORY_SERVICE_NAMES)[number];

export const factoryServiceNameSchema = z.enum(FACTORY_SERVICE_NAMES);

export interface FactoryServiceMetadata {
  name: FactoryServiceName;
  title: string;
  role: string;
  hostedIn: readonly string[];
}

export const FACTORY_SERVICES: Record<FactoryServiceName, FactoryServiceMetadata> = {
  gatekeeper: {
    name: 'gatekeeper',
    title: 'Gatekeeper',
    role: 'Perimeter defense, ingress presence, front-door authentication verification (A1, A2), wakes, and outbound routing with credential injection',
    hostedIn: ['packages/gatekeeper-ingress', 'packages/gatekeeper-egress', 'packages/auth'],
  },
  keymaster: {
    name: 'keymaster',
    title: 'Keymaster',
    role: 'Credential facilitation, OAuth connection lifecycle, and vault mapping (K1–K5)',
    hostedIn: ['packages/keymaster', 'packages/secrets-bind'],
  },
  tinman: {
    name: 'tinman',
    title: 'Tinman',
    role: 'Model service and uniform inference provider with token and cost metering (M1–M4, E5)',
    hostedIn: ['packages/gatekeeper-egress'],
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
  },
  auditor: {
    name: 'auditor',
    title: 'Auditor',
    role: 'Immutable append-only WORM execution ledger and cryptographic non-repudiation (LG1, LG2)',
    hostedIn: ['packages/ledger'],
  },
  treasurer: {
    name: 'treasurer',
    title: 'Treasurer',
    role: 'Spend governance, real-time token pricing, and budget circuit-breakers (E5, M3)',
    hostedIn: ['packages/budget', 'packages/gatekeeper-egress', 'packages/control-plane'],
  },
  bouncer: {
    name: 'bouncer',
    title: 'Bouncer',
    role: 'Governance and human-in-the-loop approvals for sensitive held actions (E4, E9)',
    hostedIn: ['packages/control-plane', 'packages/gatekeeper-egress'],
  },
  timekeeper: {
    name: 'timekeeper',
    title: 'Timekeeper',
    role: 'Agent-scoped cron scheduling and one-shot wakeup timers (§6.15)',
    hostedIn: ['packages/control-plane'],
  },
  registrar: {
    name: 'registrar',
    title: 'Registrar',
    role: 'Cartridge and skill manifest validation, admissions testing, and config store (L3, SK1–SK5)',
    hostedIn: ['packages/contract', 'packages/control-plane'],
  },
  seer: {
    name: 'seer',
    title: 'Seer',
    role: 'Telemetry, live run progress event streaming, and error diagnosis (§6.5)',
    hostedIn: ['packages/telemetry', 'packages/control-plane', 'packages/gatekeeper-egress'],
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
 * Packages reserved for a service that do not host it yet.
 * Kept out of `hostedIn` so an empty directory cannot satisfy SV1.
 */
export const RESERVED_PACKAGES: Record<string, FactoryServiceName> = {
  triage: 'seer',
};

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
