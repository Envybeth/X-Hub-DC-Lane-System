function toTrimmedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function describeUnknownStageError(error: unknown): string {
  if (!error) return 'Unknown error';
  if (error instanceof Error && toTrimmedText(error.message)) return toTrimmedText(error.message);

  if (typeof error === 'object') {
    const maybeError = error as { code?: string; message?: string; details?: string; hint?: string };
    const parts = [maybeError.code, maybeError.message, maybeError.details, maybeError.hint]
      .map((part) => toTrimmedText(part))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(' | ');
  }

  return toTrimmedText(error) || 'Unknown error';
}
