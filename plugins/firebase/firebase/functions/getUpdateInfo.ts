import type {
  AppVersionGetBundlesArgs,
  Bundle,
  FingerprintGetBundlesArgs,
  GetBundlesArgs,
  UpdateInfo,
  UpdateStatus,
} from "@hot-updater/core";
import { filterCompatibleAppVersions } from "@hot-updater/js";
import type { Firestore } from "firebase-admin/firestore";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const INIT_BUNDLE_ROLLBACK_UPDATE_INFO: UpdateInfo = {
  id: NIL_UUID,
  shouldForceUpdate: true,
  message: null,
  status: "ROLLBACK",
  storageUri: null,
  fileHash: null,
};

const convertToBundle = (data: any): Bundle => ({
  id: data.id,
  enabled: Boolean(data.enabled),
  shouldForceUpdate: Boolean(data.should_force_update),
  message: data.message || null,
  targetAppVersion: data.target_app_version,
  platform: data.platform,
  channel: data.channel || "production",
  fileHash: data.file_hash,
  gitCommitHash: data.git_commit_hash,
  fingerprintHash: data.fingerprint_hash,
  storageUri: data.storage_uri,
  originBundleId: data.origin_bundle_id || data.id,
});

const makeResponse = (bundle: Bundle, status: UpdateStatus): UpdateInfo => ({
  id: bundle.id,
  message: bundle.message,
  shouldForceUpdate: status === "ROLLBACK" ? true : bundle.shouldForceUpdate,
  status,
  storageUri: bundle.storageUri,
  fileHash: bundle.fileHash,
});

export const getUpdateInfo = async (
  db: Firestore,
  args: GetBundlesArgs,
): Promise<UpdateInfo | null> => {
  switch (args._updateStrategy) {
    case "appVersion":
      return appVersionStrategy(db, args);
    case "fingerprint":
      return fingerprintStrategy(db, args);
    default:
      return null;
  }
};

const fingerprintStrategy = async (
  db: Firestore,
  {
    platform,
    fingerprintHash,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: FingerprintGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  try {
    // Check if client's current bundle exists in the requested channel
    if (bundleId !== NIL_UUID) {
      const currentSnap = await db
        .collection("bundles")
        .where("origin_bundle_id", "==", bundleId)
        .where("channel", "==", channel)
        .limit(1)
        .get();
      if (currentSnap.empty) {
        // Current bundle not found in this channel — may have been moved or deleted
      } else {
        const data = currentSnap.docs[0].data();
        if (!data.enabled) {
          // Current bundle is disabled — will fall through to rollback logic
        }
      }
    }

    if (bundleId.localeCompare(minBundleId) < 0) {
      return null;
    }

    // Use origin_bundle_id for all ordering to treat copy-promoted bundles
    // as bundles from their original build time
    const baseQuery = db
      .collection("bundles")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .where("enabled", "==", true)
      .where("origin_bundle_id", ">=", minBundleId)
      .where("fingerprint_hash", "==", fingerprintHash);

    let updateCandidate: Bundle | null = null;
    let rollbackCandidate: Bundle | null = null;
    let currentBundle: Bundle | null = null;

    if (bundleId === NIL_UUID) {
      const snap = await baseQuery
        .orderBy("origin_bundle_id", "desc")
        .limit(1)
        .get();
      if (!snap.empty) {
        updateCandidate = convertToBundle(snap.docs[0].data());
      }
    } else {
      // Find update candidate: origin_bundle_id > bundleId (strictly newer)
      const updateSnap = await baseQuery
        .where("origin_bundle_id", ">", bundleId)
        .orderBy("origin_bundle_id", "desc")
        .limit(1)
        .get();
      if (!updateSnap.empty) {
        updateCandidate = convertToBundle(updateSnap.docs[0].data());
      }

      // Check if current bundle exists in candidates
      const currentSnap = await baseQuery
        .where("origin_bundle_id", "==", bundleId)
        .limit(1)
        .get();
      if (!currentSnap.empty) {
        currentBundle = convertToBundle(currentSnap.docs[0].data());
      }

      // Find rollback candidate: origin_bundle_id < bundleId
      const rollbackSnap = await baseQuery
        .where("origin_bundle_id", "<", bundleId)
        .orderBy("origin_bundle_id", "desc")
        .limit(1)
        .get();
      if (!rollbackSnap.empty) {
        rollbackCandidate = convertToBundle(rollbackSnap.docs[0].data());
      }
    }

    if (bundleId === NIL_UUID) {
      return updateCandidate ? makeResponse(updateCandidate, "UPDATE") : null;
    }

    if (currentBundle) {
      // Current bundle exists and is enabled — check if there's a newer one
      if (updateCandidate) {
        return makeResponse(updateCandidate, "UPDATE");
      }
      return null;
    }

    // Current bundle not found in candidates
    if (updateCandidate) {
      return makeResponse(updateCandidate, "UPDATE");
    }
    if (rollbackCandidate) {
      return makeResponse(rollbackCandidate, "ROLLBACK");
    }

    return bundleId === minBundleId ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};

const appVersionStrategy = async (
  db: Firestore,
  {
    platform,
    appVersion,
    bundleId,
    minBundleId = NIL_UUID,
    channel = "production",
  }: AppVersionGetBundlesArgs,
): Promise<UpdateInfo | null> => {
  try {
    // Check if client's current bundle exists in the requested channel
    if (bundleId !== NIL_UUID) {
      const currentSnap = await db
        .collection("bundles")
        .where("origin_bundle_id", "==", bundleId)
        .where("channel", "==", channel)
        .limit(1)
        .get();
      if (currentSnap.empty) {
        // Current bundle not found in this channel
      }
    }

    if (bundleId.localeCompare(minBundleId) < 0) {
      return null;
    }

    const appVersionsSnapshot = await db
      .collection("target_app_versions")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .select("target_app_version")
      .get();

    const appVersions = Array.from(
      new Set(
        appVersionsSnapshot.docs.map(
          (doc) => doc.data().target_app_version as string,
        ),
      ),
    );

    const targetAppVersionList = filterCompatibleAppVersions(
      appVersions,
      appVersion,
    );

    if (targetAppVersionList.length === 0) {
      return bundleId === minBundleId ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
    }

    // Use origin_bundle_id for all ordering to treat copy-promoted bundles
    // as bundles from their original build time
    const baseQuery = db
      .collection("bundles")
      .where("platform", "==", platform)
      .where("channel", "==", channel)
      .where("enabled", "==", true)
      .where("origin_bundle_id", ">=", minBundleId)
      .where("target_app_version", "in", targetAppVersionList);

    let updateCandidate: Bundle | null = null;
    let rollbackCandidate: Bundle | null = null;
    let currentBundle: Bundle | null = null;

    if (bundleId === NIL_UUID) {
      const snap = await baseQuery
        .orderBy("origin_bundle_id", "desc")
        .limit(1)
        .get();
      if (!snap.empty) {
        updateCandidate = convertToBundle(snap.docs[0].data());
      }
    } else {
      // Find update candidate: origin_bundle_id > bundleId (strictly newer)
      const updateSnap = await baseQuery
        .where("origin_bundle_id", ">", bundleId)
        .orderBy("origin_bundle_id", "desc")
        .limit(1)
        .get();
      if (!updateSnap.empty) {
        updateCandidate = convertToBundle(updateSnap.docs[0].data());
      }

      // Check if current bundle exists in candidates
      const currentSnap = await baseQuery
        .where("origin_bundle_id", "==", bundleId)
        .limit(1)
        .get();
      if (!currentSnap.empty) {
        currentBundle = convertToBundle(currentSnap.docs[0].data());
      }

      // Find rollback candidate: origin_bundle_id < bundleId
      const rollbackSnap = await baseQuery
        .where("origin_bundle_id", "<", bundleId)
        .orderBy("origin_bundle_id", "desc")
        .limit(1)
        .get();
      if (!rollbackSnap.empty) {
        rollbackCandidate = convertToBundle(rollbackSnap.docs[0].data());
      }
    }

    if (bundleId === NIL_UUID) {
      return updateCandidate ? makeResponse(updateCandidate, "UPDATE") : null;
    }

    if (currentBundle) {
      // Current bundle exists and is enabled — check if there's a newer one
      if (updateCandidate) {
        return makeResponse(updateCandidate, "UPDATE");
      }
      return null;
    }

    // Current bundle not found in candidates
    if (updateCandidate) {
      return makeResponse(updateCandidate, "UPDATE");
    }
    if (rollbackCandidate) {
      return makeResponse(rollbackCandidate, "ROLLBACK");
    }

    return bundleId === minBundleId ? null : INIT_BUNDLE_ROLLBACK_UPDATE_INFO;
  } catch (error) {
    console.error("Error in getUpdateInfo:", error);
    throw error;
  }
};
