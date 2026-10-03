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

/**
 * Service metadata description.
 */
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
    role: 'Perimeter defense, ingress presence, wakes, and outbound routing with credential injection',
    hostedIn: ['packages/gatekeeper-ingress', 'packages/gatekeeper-egress'],
  },
  keymaster: {
    name: 'keymaster',
    title: 'Keymaster',
    role: 'Credential facilitation, OAuth connection lifecycle, and vault mapping',
    hostedIn: ['packages/keymaster', 'packages/secrets-bind', 'packages/auth'],
  },
  tinman: {
    name: 'tinman',
    title: 'Tinman',
    role: 'Model service and uniform inference provider with token and cost metering',
    hostedIn: ['packages/gatekeeper-egress'],
  },
  secretary: {
    name: 'secretary',
    title: 'Secretary',
    role: 'State hydration and remote object storage synchronization (The Safe)',
    hostedIn: ['packages/hydrate'],
  },
  landlord: {
    name: 'landlord',
    title: 'Landlord',
    role: 'Compute lifecycle management, wake-from-zero, warm-down, and turn mailbox delivery',
    hostedIn: ['packages/control-plane'],
  },
  auditor: {
    name: 'auditor',
    title: 'Auditor',
    role: 'Immutable append-only WORM execution ledger and cryptographic non-repudiation',
    hostedIn: ['packages/ledger'],
  },
  treasurer: {
    name: 'treasurer',
    title: 'Treasurer',
    role: 'Spend governance, real-time token pricing, and budget circuit-breakers',
    hostedIn: ['packages/budget', 'packages/gatekeeper-egress', 'packages/control-plane'],
  },
  bouncer: {
    name: 'bouncer',
    title: 'Bouncer',
    role: 'Governance and human-in-the-loop approvals for sensitive held actions',
    hostedIn: ['packages/control-plane', 'packages/gatekeeper-egress'],
  },
  timekeeper: {
    name: 'timekeeper',
    title: 'Timekeeper',
    role: 'Agent-scoped cron scheduling and one-shot wakeup timers',
    hostedIn: ['packages/control-plane'],
  },
  registrar: {
    name: 'registrar',
    title: 'Registrar',
    role: 'Cartridge and skill manifest validation, admissions testing, and config store',
    hostedIn: ['packages/contract', 'packages/control-plane'],
  },
  seer: {
    name: 'seer',
    title: 'Seer',
    role: 'Telemetry, live run progress event streaming, and error diagnosis',
    hostedIn: ['packages/telemetry', 'packages/triage'],
  },
};
