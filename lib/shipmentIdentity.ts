function trimToNull(value?: string | null): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizePuNumber(value?: string | null): string | null {
  return trimToNull(value);
}

export function normalizePuDate(value?: string | null): string | null {
  const trimmed = trimToNull(value);
  if (!trimmed) return null;

  const isoDateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) {
    return isoDateMatch[1];
  }

  return trimmed;
}

export function buildPuLoadKey(puNumber?: string | null, puDate?: string | null): string | null {
  const normalizedPuNumber = normalizePuNumber(puNumber);
  const normalizedPuDate = normalizePuDate(puDate);
  if (!normalizedPuNumber || !normalizedPuDate) return null;
  return `${normalizedPuNumber}::${normalizedPuDate}`;
}
