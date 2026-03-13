type CompiledPalletDisplayItem = {
  compiled_pallet_id?: number | null;
  pt_number?: string | null;
};

export function normalizeDigits(value?: string | null): string {
  return (value || '').replace(/\D/g, '');
}

export function compareTextNumeric(a: string, b: string): number {
  const aDigits = normalizeDigits(a);
  const bDigits = normalizeDigits(b);
  if (aDigits && bDigits) {
    const aNum = Number(aDigits);
    const bNum = Number(bDigits);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
      return aNum - bNum;
    }
  }
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

function getSortedUniqueLabels(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  ).sort(compareTextNumeric);
}

export function getRangeLabel(values: Array<string | null | undefined>): string {
  const labels = getSortedUniqueLabels(values);
  if (labels.length === 0) return '-';
  if (labels.length === 1) return labels[0];
  return `${labels[0]} - ${labels[labels.length - 1]}`;
}

export function buildCompiledMembersById<T extends CompiledPalletDisplayItem>(items: T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();

  items.forEach((item) => {
    const compiledId = item.compiled_pallet_id;
    if (!Number.isFinite(Number(compiledId))) return;
    const normalizedId = Number(compiledId);
    if (normalizedId <= 0) return;
    const current = groups.get(normalizedId) || [];
    current.push(item);
    groups.set(normalizedId, current);
  });

  groups.forEach((members, compiledId) => {
    groups.set(
      compiledId,
      [...members].sort((left, right) => compareTextNumeric(String(left.pt_number || ''), String(right.pt_number || '')))
    );
  });

  return groups;
}
