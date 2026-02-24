function getSyncAgeInDays(pt: { last_synced_at?: string }, mostRecentSyncDate?: Date | null): number | null {
  if (!pt.last_synced_at || !mostRecentSyncDate) return null;

  const ptSyncDate = new Date(pt.last_synced_at);
  return Math.abs(mostRecentSyncDate.getTime() - ptSyncDate.getTime()) / (1000 * 60 * 60 * 24);
}

export function isPTArchived(pt: { last_synced_at?: string }, mostRecentSyncDate?: Date | null): boolean {
  if (!pt.last_synced_at) return true;
  const daysDifference = getSyncAgeInDays(pt, mostRecentSyncDate);
  if (daysDifference === null) return false;
  return daysDifference > 1;
}

export function isPTArchivedOver60Days(pt: { last_synced_at?: string }, mostRecentSyncDate?: Date | null): boolean {
  if (!pt.last_synced_at) return true;
  const daysDifference = getSyncAgeInDays(pt, mostRecentSyncDate);
  if (daysDifference === null) return false;
  return daysDifference > 60;
}
