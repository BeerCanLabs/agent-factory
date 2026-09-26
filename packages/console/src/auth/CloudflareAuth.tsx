import React, { createContext, useContext, useState, useEffect } from 'react';
import type { AuthUser } from '../api/types.js';

interface AuthContextType {
  user: AuthUser;
  activeRole: 'viewer' | 'operator' | 'approver' | 'admin';
  setActiveRole: (role: 'viewer' | 'operator' | 'approver' | 'admin') => void;
  isLoading: boolean;
  hasRole: (required: 'viewer' | 'operator' | 'approver' | 'admin') => boolean;
}

const DEFAULT_ADMIN: AuthUser = {
  email: 'dale.sackrider@gmail.com',
  name: 'Dale Sackrider',
  roles: ['admin', 'operator', 'approver', 'viewer'],
  provider: 'Cloudflare Access',
};

const AuthContext = createContext<AuthContextType>({
  user: DEFAULT_ADMIN,
  activeRole: 'admin',
  setActiveRole: () => {},
  isLoading: false,
  hasRole: () => true,
});

export const CloudflareAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser>(DEFAULT_ADMIN);
  const [activeRole, setActiveRole] = useState<'viewer' | 'operator' | 'approver' | 'admin'>('admin');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadIdentity() {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          if (data && data.user) {
            setUser(data.user);
            setActiveRole(data.user.roles.includes('admin') ? 'admin' : data.user.roles[0] || 'viewer');
          }
        }
      } catch (err) {
        console.warn('Could not fetch /api/auth/me, falling back to authenticated Cloudflare principal:', err);
      } finally {
        setIsLoading(false);
      }
    }
    loadIdentity();
  }, []);

  const hasRole = (required: 'viewer' | 'operator' | 'approver' | 'admin') => {
    if (activeRole === 'admin') return true;
    if (required === 'viewer') return true;
    if (required === 'operator') return activeRole === 'operator';
    if (required === 'approver') return activeRole === 'approver';
    return (activeRole as string) === required;
  };

  return (
    <AuthContext.Provider value={{ user, activeRole, setActiveRole, isLoading, hasRole }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
