export function isPTDefunct(pt: { last_synced_at?: string }, mostRecentSyncDate?: Date | null): boolean {
  if (!pt.last_synced_at) return true; // No sync date = defunct
  if (!mostRecentSyncDate) return false; // Can't determine without reference date
  
  const ptSyncDate = new Date(pt.last_synced_at);
  const daysDifference = Math.abs(mostRecentSyncDate.getTime() - ptSyncDate.getTime()) / (1000 * 60 * 60 * 24);
  
  // PT is defunct if it's more than 2 days behind the most recent sync
  return daysDifference > 1;
}