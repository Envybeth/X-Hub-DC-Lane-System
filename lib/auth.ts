export type AppRole = 'admin' | 'worker' | 'guest';

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(value));
}

export function getAuthEmailDomain(): string {
  return (process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || 'lane.local').trim().toLowerCase();
}

export function usernameToInternalEmail(username: string): string {
  return `${normalizeUsername(username)}@${getAuthEmailDomain()}`;
}

export function identifierToEmail(identifier: string): string {
  const normalized = identifier.trim().toLowerCase();
  if (normalized.includes('@')) return normalized;
  return usernameToInternalEmail(normalized);
}
