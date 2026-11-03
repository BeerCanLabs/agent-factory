/**
 * S9 (R4, R7, D23): what the console shows comes from the factory's own answer (`/api/v1/whoami`), never a guess.
 * No anonymous viewer: until whoami answers nothing is shown, and a signed-in person with no grant sees only the
 * no-access screen. The control plane still enforces every call (§6.12 A2); this only decides what to render.
 */
export type Whoami = {
  actor?: string;
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

/** A principal id an admin may act as. */
export const validActAs = (v: string): boolean => /^user:[A-Za-z0-9._@+-]{1,200}$/.test(v);
