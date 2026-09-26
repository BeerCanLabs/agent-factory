import React from 'react';
import { useAuth } from './CloudflareAuth.js';

interface RoleGuardProps {
  required: 'viewer' | 'operator' | 'approver' | 'admin';
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export const RoleGuard: React.FC<RoleGuardProps> = ({ required, children, fallback = null }) => {
  const { hasRole } = useAuth();
  if (!hasRole(required)) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
};
