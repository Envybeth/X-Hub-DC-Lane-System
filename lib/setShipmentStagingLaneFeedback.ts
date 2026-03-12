import { SetShipmentStagingLaneError, type SetShipmentStagingLaneResult } from '@/lib/setShipmentStagingLane';

type SuccessFeedbackOptions = {
  result: SetShipmentStagingLaneResult;
  puNumber?: string | null;
  queueRefreshed?: boolean;
};

function toTrimmedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function buildSetShipmentStagingLaneSuccessMessage(options: SuccessFeedbackOptions): string {
  const puNumber = toTrimmedText(options.puNumber);
  let message = `Set staging lane L${options.result.targetLane}`;

  if (puNumber) {
    message += ` for PU ${puNumber}`;
  }

  message += '.';

  if (options.result.alreadyInLaneCount > 0) {
    message += ` ${options.result.alreadyInLaneCount} PT(s) auto-linked.`;
  } else if (options.result.stagedPtIds.length > 0) {
    message += ` ${options.result.stagedPtIds.length} PT(s) swept into staging.`;
  }

  if (options.queueRefreshed) {
    message += ' Queue refreshed.';
  }

  return message;
}

export function buildSetShipmentStagingLaneErrorMessage(error: unknown, requestedLane: string | number): string {
  const requestedLaneLabel = toTrimmedText(requestedLane) || 'that';

  if (error instanceof SetShipmentStagingLaneError) {
    if (error.code === 'lane_missing') {
      return `Lane ${requestedLaneLabel} does not exist.`;
    }

    if (error.code === 'lane_conflict') {
      return `Lane ${requestedLaneLabel} has ${error.foreignPtIds.length} PT(s) from other load(s).`;
    }

    if (error.code === 'invalid_input') {
      return 'PU number, PU date, and lane are required.';
    }
  }

  return 'Failed to set staging lane.';
}

export function getSetShipmentStagingLaneSuccessToastDurationMs(result: SetShipmentStagingLaneResult): number | undefined {
  if (result.alreadyInLaneCount > 0) return 6500;
  return undefined;
}
