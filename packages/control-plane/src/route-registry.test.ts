import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRIVILEGES, type Privilege } from '@beercanlabs/factory-bouncer';
import {
  CONTROL_PLANE_ROUTES,
  ROUTE_EXCEPTIONS,
  ROUTE_PROTECTION_MECHANISMS,
  type ControlPlaneRoute,
  type RouteException,
  pathToRegex,
  matchRoute,
  isRoutePrivileged,
  getRoutePrivileges,
  getRouteException,
  validateRouteRegistry,
  assertValidRouteRegistry,
} from './route-registry.js';

describe('Route Registry (plans/factory-auth.md S14, #355)', () => {
  it('passes assertValidRouteRegistry on production tables', () => {
    assert.doesNotThrow(() => assertValidRouteRegistry());
  });

  it('uniqueness: every (method, pattern) pair is unique', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const r of CONTROL_PLANE_ROUTES) {
      const key = `${r.method} ${r.pattern}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    assert.deepEqual(duplicates, [], 'no duplicate (method, pattern) entries in CONTROL_PLANE_ROUTES');
  });

  it('every route declares either a valid Privilege (or list) OR an exception, never both or neither', () => {
    for (const r of CONTROL_PLANE_ROUTES) {
      const key = `${r.method} ${r.pattern}`;
      const hasPriv = r.privilege !== undefined;
      const hasExc = r.exception !== undefined;
      assert.ok(hasPriv || hasExc, `Route '${key}' has neither privilege nor exception`);
      assert.ok(!(hasPriv && hasExc), `Route '${key}' has both privilege and exception`);
    }
  });

  it('every declared privilege is in PRIVILEGES', () => {
    const known = new Set<string>(PRIVILEGES);
    const unknown: string[] = [];
    for (const r of CONTROL_PLANE_ROUTES) {
      for (const p of getRoutePrivileges(r)) {
        if (!known.has(p)) unknown.push(`${r.method} ${r.pattern}: unknown privilege '${p}'`);
      }
    }
    assert.deepEqual(unknown, []);
  });

  it('every route exception reference exists in ROUTE_EXCEPTIONS and is valid', () => {
    for (const r of CONTROL_PLANE_ROUTES) {
      if (r.exception) {
        const exc = ROUTE_EXCEPTIONS[r.exception as keyof typeof ROUTE_EXCEPTIONS];
        assert.ok(exc, `Route '${r.method} ${r.pattern}' references unknown exception '${r.exception}'`);
        assert.ok(ROUTE_PROTECTION_MECHANISMS.includes(exc.protection), `Exception '${exc.id}' has invalid protection '${exc.protection}'`);
        assert.ok(exc.rationale && exc.rationale.trim().length > 0, `Exception '${exc.id}' has empty rationale`);
        if (exc.protection === 'transitional') {
          assert.ok(exc.retiringStory && exc.retiringStory.trim().length > 0, `Transitional exception '${exc.id}' missing retiringStory`);
        }
      }
    }
  });

  it('pathToRegex compiles parameter templates into working matchers', () => {
    const re1 = pathToRegex('/ui');
    assert.ok(re1.test('/ui'));
    assert.ok(!re1.test('/ui/other'));

    const re2 = pathToRegex('/api/v1/agents/:id/policy');
    assert.ok(re2.test('/api/v1/agents/castle/policy'));
    assert.ok(re2.test('/api/v1/agents/agent-123/policy'));
    assert.ok(!re2.test('/api/v1/agents/castle/other'));
    assert.ok(!re2.test('/api/v1/agents/castle/policy/sub'));

    const re3 = pathToRegex('/api/v1/identity-links/:provider/:id');
    assert.ok(re3.test('/api/v1/identity-links/discord/user-456'));
  });

  it('matchRoute locates declared routes by HTTP method and URL path', () => {
    const uiRoute = matchRoute('GET', '/ui');
    assert.ok(uiRoute);
    assert.equal(uiRoute?.exception, 'transitional-ui');

    const agentPolicy = matchRoute('GET', '/api/v1/agents/castle/policy');
    assert.ok(agentPolicy);
    assert.equal(agentPolicy?.privilege, 'policy.read');

    const runInput = matchRoute('GET', '/api/v1/runs/run-99/input');
    assert.ok(runInput);
    assert.equal(runInput?.exception, 'run-token');

    assert.equal(matchRoute('DELETE', '/ui'), undefined);
    assert.equal(matchRoute('GET', '/non-existent-route'), undefined);
  });

  it('isRoutePrivileged and getRoutePrivileges distinguish privileged vs exception routes', () => {
    const privRoute: ControlPlaneRoute = { method: 'GET', pattern: '/api/v1/agents', privilege: 'agents.read' };
    assert.equal(isRoutePrivileged(privRoute), true);
    assert.deepEqual(getRoutePrivileges(privRoute), ['agents.read']);

    const multiPrivRoute: ControlPlaneRoute = { method: 'POST', pattern: '/api/v1/registry/skills', privilege: ['skills.register', 'skills.version.add'] };
    assert.equal(isRoutePrivileged(multiPrivRoute), true);
    assert.deepEqual(getRoutePrivileges(multiPrivRoute), ['skills.register', 'skills.version.add']);

    const excRoute: ControlPlaneRoute = { method: 'GET', pattern: '/ui', exception: 'transitional-ui' };
    assert.equal(isRoutePrivileged(excRoute), false);
    assert.deepEqual(getRoutePrivileges(excRoute), []);
    assert.equal(getRouteException(excRoute)?.protection, 'transitional');
  });

  describe('validateRouteRegistry validation rules', () => {
    it('flags unprivileged route lacking exception reference', () => {
      const badRoutes = [
        { method: 'GET', pattern: '/open-door' },
      ] as unknown as ControlPlaneRoute[];
      const res = validateRouteRegistry(badRoutes, ROUTE_EXCEPTIONS);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("must declare either a Bouncer privilege or reference an entry in ROUTE_EXCEPTIONS")));
    });

    it('flags route declaring both privilege and exception', () => {
      const badRoutes = [
        { method: 'GET', pattern: '/mixed', privilege: 'agents.read', exception: 'transitional-ui' },
      ] as unknown as ControlPlaneRoute[];
      const res = validateRouteRegistry(badRoutes, ROUTE_EXCEPTIONS);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('cannot declare both a privilege and an exception')));
    });

    it('flags duplicate (method, pattern) registration', () => {
      const badRoutes: ControlPlaneRoute[] = [
        { method: 'GET', pattern: '/dup', privilege: 'agents.read' },
        { method: 'GET', pattern: '/dup', privilege: 'agents.read' },
      ];
      const res = validateRouteRegistry(badRoutes, ROUTE_EXCEPTIONS);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Duplicate route registration: 'GET /dup'")));
    });

    it('flags unknown privilege name', () => {
      const badRoutes = [
        { method: 'GET', pattern: '/invalid-priv', privilege: 'nonexistent.privilege' as Privilege },
      ] as unknown as ControlPlaneRoute[];
      const res = validateRouteRegistry(badRoutes, ROUTE_EXCEPTIONS);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("unknown Privilege 'nonexistent.privilege'")));
    });

    it('flags unknown exception reference', () => {
      const badRoutes = [
        { method: 'GET', pattern: '/bad-exc', exception: 'does-not-exist' },
      ] as unknown as ControlPlaneRoute[];
      const res = validateRouteRegistry(badRoutes, ROUTE_EXCEPTIONS);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("unknown exception 'does-not-exist'")));
    });

    it('flags transitional exception missing retiringStory or with invalid format', () => {
      const badExceptions: Record<string, RouteException> = {
        'bad-trans': {
          id: 'bad-trans',
          protection: 'transitional',
          rationale: 'some rationale',
        },
        'bad-format': {
          id: 'bad-format',
          protection: 'transitional',
          retiringStory: 'invalid-story',
          rationale: 'some rationale',
        },
      };
      const res = validateRouteRegistry([], badExceptions);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Transitional exception 'bad-trans' must specify a retiringStory")));
      assert.ok(res.errors.some((e) => e.includes("Transitional exception 'bad-format' has invalid retiringStory 'invalid-story'")));
    });

    it('flags plannedIn with invalid format', () => {
      const badExceptions: Record<string, RouteException> = {
        'bad-plan': {
          id: 'bad-plan',
          protection: 'login-page',
          plannedIn: 'not-a-story',
          rationale: 'some rationale',
        },
      };
      const res = validateRouteRegistry([], badExceptions);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Exception 'bad-plan' has invalid plannedIn 'not-a-story'")));
    });

    it('flags unreferenced exception without plannedIn', () => {
      const unusedExceptions: Record<string, RouteException> = {
        'unused-exc': {
          id: 'unused-exc',
          protection: 'identity-probe',
          rationale: 'some rationale',
        },
      };
      const res = validateRouteRegistry([], unusedExceptions);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Exception 'unused-exc' without plannedIn is not referenced by any route")));
    });

    it('flags exception missing rationale', () => {
      const badExceptions: Record<string, RouteException> = {
        'bad-rat': {
          id: 'bad-rat',
          protection: 'identity-probe',
          rationale: '',
          plannedIn: 'S1',
        },
      };
      const res = validateRouteRegistry([], badExceptions);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes("Exception 'bad-rat' is missing required rationale")));
    });

    it('flags transitional exception referenced by multiple routes', () => {
      const transExceptions: Record<string, RouteException> = {
        'trans-one': {
          id: 'trans-one',
          protection: 'transitional',
          retiringStory: 'S1',
          rationale: 'temporary exception for one route',
        },
      };
      const sharedRoutes: ControlPlaneRoute[] = [
        { method: 'GET', pattern: '/one', exception: 'trans-one' },
        { method: 'POST', pattern: '/two', exception: 'trans-one' },
      ];
      const res = validateRouteRegistry(sharedRoutes, transExceptions);
      assert.equal(res.valid, false);
      assert.ok(
        res.errors.some((e) => e.includes("Transitional exception 'trans-one' may only cover a single route, but is referenced by 2 routes")),
        `Expected transitional reuse error, got: ${res.errors.join('; ')}`,
      );
    });
  });
});
