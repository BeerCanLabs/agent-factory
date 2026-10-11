/**
 * K4 backstop (GAP-067): an agent directs a person only to the factory's reconnect link. A model can still write its
 * own sign-in link (an invented OAuth client, a third-party redirect). On routes marked `stripSignInLinks`, the
 * gatekeeper-egress replaces every sign-in or authorization URL in a JSON message body that does not point at the
 * factory before the message leaves.
 */

/** URLs that ask someone to sign in or grant access: OAuth endpoints, consent and login pages, anything with a client_id. */
const SIGN_IN_URL = /https?:\/\/[^\s<>"'()[\]]*(?:oauth|authori[sz]|\/connect|\/signin|\/sign-in|\/login|\/consent|client_id=)[^\s<>"'()[\]]*/gi;

export function signInNotice(factoryUrl: string | undefined): string {
  return factoryUrl
    ? `[sign-in link removed: connections are made only through the factory, ${factoryUrl.replace(/\/$/, '')} → Credentials]`
    : '[sign-in link removed: connections are made only through the factory]';
}

/** Replace sign-in URLs not on the factory's host in one string. Returns the new text and how many were removed. */
export function stripSignInLinksFromText(text: string, factoryUrl: string | undefined): { text: string; removed: number } {
  const factoryHost = factoryUrl ? safeHost(factoryUrl) : undefined;
  let removed = 0;
  const out = text.replace(SIGN_IN_URL, (url) => {
    if (factoryHost && safeHost(url) === factoryHost) return url;
    removed++;
    return signInNotice(factoryUrl);
  });
  return { text: out, removed };
}

/** Every string in a JSON value (message content, embed fields, components), rewritten. */
export function stripSignInLinksFromJson(value: unknown, factoryUrl: string | undefined): { value: unknown; removed: number } {
  let removed = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = stripSignInLinksFromText(v, factoryUrl);
      removed += r.removed;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  return { value: out, removed };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}
