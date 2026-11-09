/**
 * S9 (R4, R7, D23): what the console shows comes from the factory's own answer (`/api/v1/whoami`), never a guess.
 * No anonymous viewer: until whoami answers nothing is shown, and a signed-in person with no grant sees only the
 * no-access screen. The control plane still enforces every call (§6.12 A2); this only decides what to render.
 */
export type Whoami = {
  actor?: string;
  principal?: string;
  roles?: string[];
  grants?: unknown[];
  onBehalfOf?: string;
  breakGlassAlert?: unknown;
  privileges?: { fleet?: string[]; agents?: Record<string, string[]>; skills?: Record<string, string[]> };
};

export const ACT_AS_KEY = 'factory.actAs';

/** Any role, grant or privilege at all; otherwise the person gets the no-access screen. */
export function hasAnyAccess(w: Whoami | null | undefined): boolean {
  if (!w || !w.actor) return false;
  const p = w.privileges ?? {};
  return Boolean((w.roles?.length ?? 0) || (w.grants?.length ?? 0) || (p.fleet?.length ?? 0) || Object.keys(p.agents ?? {}).length || Object.keys(p.skills ?? {}).length);
}

export const holds = (w: Whoami | null | undefined, privilege: string): boolean => Boolean(w?.privileges?.fleet?.includes(privilege));

/** People (principals, emails, domain grants, grants) and Act-As are for whoever holds `grants.manage` fleet-wide. */
export const canManagePeople = (w: Whoami | null | undefined): boolean => holds(w, 'grants.manage');

/** Keys are each person's own: anyone with access manages their own. */
export const canManageOwnKeys = (w: Whoami | null | undefined): boolean => hasAnyAccess(w);

/** M5(4): Canonical `user:<id>` of the effective caller (respecting `onBehalfOf` when acting as a user). */
export function effectivePrincipalOf(w: Whoami | null | undefined): string | undefined {
  if (!w) return undefined;
  if (typeof w.onBehalfOf === 'string' && w.onBehalfOf.startsWith('user:')) return w.onBehalfOf;
  if (typeof w.principal === 'string' && w.principal.startsWith('user:')) return w.principal;
  if (typeof w.actor === 'string' && w.actor.startsWith('user:')) return w.actor;
  return undefined;
}

/** M5(4): Agent owners & submitters holding `subscriptions.own` manage their own `personal` BYOM subscriptions. */
export const canOwnSubscriptions = (w: Whoami | null | undefined): boolean => holds(w, 'subscriptions.own');

/** M5(4): Factory admins holding `subscriptions.read` inspect `factory` and fleet-wide subscription state. */
export const canReadAllSubscriptions = (w: Whoami | null | undefined): boolean => holds(w, 'subscriptions.read');

/** M5(4): Factory admins holding `subscriptions.manage` connect and manage `factory` subscriptions. */
export const canManageFactorySubscriptions = (w: Whoami | null | undefined): boolean => holds(w, 'subscriptions.manage');

/** M5(1): Factory admins holding `models.manage` admit and price `factory` catalog models. */
export const canManageCatalogModels = (w: Whoami | null | undefined): boolean => holds(w, 'models.manage');

/** Whether the caller can view the Subscriptions screen (either My Subscriptions or Factory Subscriptions). */
export const canAccessSubscriptions = (w: Whoami | null | undefined): boolean =>
  canOwnSubscriptions(w) || canReadAllSubscriptions(w) || canManageFactorySubscriptions(w);

/** A principal id an admin may act as. */
export const validActAs = (v: string): boolean => /^user:[A-Za-z0-9._@+-]{1,200}$/.test(v);
