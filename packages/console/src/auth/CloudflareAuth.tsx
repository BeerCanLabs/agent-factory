import React, { createContext, useContext, useState, useEffect } from 'react';
import type { AuthUser } from '../api/types.js';
import { ACT_AS_KEY, type Whoami } from './access-gate.js';

interface AuthContextType {
  user: AuthUser;
  activeRole: 'viewer' | 'operator' | 'approver' | 'admin';
  setActiveRole: (role: 'viewer' | 'operator' | 'approver' | 'admin') => void;
  isLoading: boolean;
  hasRole: (required: 'viewer' | 'operator' | 'approver' | 'admin') => boolean;
  /** S9: the factory's own whoami answer; undefined until it arrives or when signed out. */
  whoami?: Whoami;
  actAs: string | null;
  setActAs: (principal: string | null) => void;
}

// S9: no anonymous viewer. Until the control plane confirms who the caller is (/api/auth/me → /api/v1/whoami) the
// person holds no role; with no grant they see the no-access screen. The control plane enforces every call (§6.12 A2).
const ANONYMOUS: AuthUser = {
  email: '',
  name: 'Not signed in',
  roles: [],
  provider: 'none',
};

const AuthContext = createContext<AuthContextType>({
  user: ANONYMOUS,
  activeRole: 'viewer',
  setActiveRole: () => {},
  isLoading: false,
  hasRole: () => false,
  actAs: null,
  setActAs: () => {},
});

export const CloudflareAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser>(ANONYMOUS);
  const [activeRole, setActiveRole] = useState<'viewer' | 'operator' | 'approver' | 'admin'>('viewer');
  const [isLoading, setIsLoading] = useState(true);
  const [whoami, setWhoami] = useState<Whoami | undefined>(undefined);
  const [actAs, setActAsState] = useState<string | null>(() => (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(ACT_AS_KEY) : null));
  const setActAs = (p: string | null) => {
    if (p) sessionStorage.setItem(ACT_AS_KEY, p);
    else sessionStorage.removeItem(ACT_AS_KEY);
    setActAsState(p);
    window.location.reload(); // every view reloads as the chosen person
  };

  useEffect(() => {
    async function loadIdentity() {
      try {
        const asWho = sessionStorage.getItem(ACT_AS_KEY);
        const res = await fetch('/api/auth/me', asWho ? { headers: { 'x-factory-act-as': asWho } } : undefined);
        if (res.ok) {
          const data = await res.json();
          if (data && data.user) {
            setUser(data.user);
            setWhoami(data.whoami ?? { actor: data.user.actor, roles: data.user.roles });
            setActiveRole(data.user.roles.includes('admin') ? 'admin' : data.user.roles[0] || 'viewer');
          }
        }
      } catch (err) {
        console.warn('Could not fetch /api/auth/me; showing nothing until the factory answers:', err);
      } finally {
        setIsLoading(false);
      }
    }
    loadIdentity();
  }, []);

  const hasRole = (required: 'viewer' | 'operator' | 'approver' | 'admin') => {
    if (!user.roles.length) return false; // S9: no role, no button
    if (activeRole === 'admin') return true;
    if (required === 'viewer') return true;
    if (required === 'operator') return activeRole === 'operator';
    if (required === 'approver') return activeRole === 'approver';
    return (activeRole as string) === required;
  };

  return (
    <AuthContext.Provider value={{ user, activeRole, setActiveRole, isLoading, hasRole, whoami, actAs, setActAs }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
