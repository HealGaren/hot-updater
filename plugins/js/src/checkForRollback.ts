import { type Bundle, NIL_UUID } from "@hot-updater/core";
import { isNullable } from "./utils";

const getUUIDv7Timestamp = (uuid: string) => uuid.slice(0, 13);

export const checkForRollback = (
  bundles: Bundle[],
  currentBundleId: string,
) => {
  if (currentBundleId === NIL_UUID) {
    return false;
  }

  if (bundles.length === 0) {
    return true;
  }

  const currentTs = getUUIDv7Timestamp(currentBundleId);
  const enabled = bundles.find(
    (item) => getUUIDv7Timestamp(item.id) === currentTs,
  )?.enabled;
  const availableOldVersion = bundles.find(
    (item) => getUUIDv7Timestamp(item.id) < currentTs && item.enabled,
  )?.enabled;

  if (isNullable(enabled)) {
    return Boolean(availableOldVersion);
  }
  return !enabled;
};
