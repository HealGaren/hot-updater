import { colors, loadConfig, p } from "@hot-updater/cli-tools";

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractBundleUuid(storageUri: string): string | null {
  try {
    const url = new URL(storageUri);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const uuid = pathSegments.find((segment) => UUID_REGEX.test(segment));
    return uuid ?? null;
  } catch {
    return null;
  }
}

function toDirectoryUri(storageUri: string): string | null {
  try {
    const url = new URL(storageUri);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const uuidIndex = pathSegments.findIndex((s) => UUID_REGEX.test(s));
    if (uuidIndex === -1) return null;
    const dirPath = pathSegments.slice(0, uuidIndex + 1).join("/");
    return `${url.protocol}//${url.hostname}/${dirPath}`;
  } catch {
    return null;
  }
}

const BATCH_SIZE = 10;

export interface StorageGcOptions {
  yes?: boolean;
}

export async function storageGc(options: StorageGcOptions) {
  p.intro("Storage Garbage Collection");

  const config = await loadConfig(null);
  if (!config) {
    p.log.error("No config found. Please run `hot-updater init` first.");
    process.exit(1);
  }

  const [storagePlugin, databasePlugin] = await Promise.all([
    config.storage(),
    config.database(),
  ]);

  if (!storagePlugin.list) {
    console.log("");
    p.log.error(
      `Storage plugin "${colors.blue(storagePlugin.name)}" does not support list().`,
    );
    p.log.info(
      "Garbage collection requires a storage plugin that implements list() (e.g., S3, Firebase Storage, Supabase Storage).",
    );
    process.exit(1);
  }

  const spinner = p.spinner();

  try {
    spinner.start("Listing storage objects");

    let allStorageUris: string[];
    try {
      allStorageUris = await storagePlugin.list();
    } catch (e) {
      spinner.stop("Failed to list storage objects");
      console.log("");
      p.log.error(
        e instanceof Error ? e.message : "Unknown error while listing objects",
      );
      process.exit(1);
    }

    const storageUuidToDirUri = new Map<string, string>();
    for (const uri of allStorageUris) {
      const uuid = extractBundleUuid(uri);
      if (!uuid) continue;
      if (!storageUuidToDirUri.has(uuid)) {
        const dirUri = toDirectoryUri(uri);
        if (dirUri) {
          storageUuidToDirUri.set(uuid, dirUri);
        }
      }
    }

    spinner.stop(
      `Found ${colors.green(String(storageUuidToDirUri.size))} bundle directories in storage (${allStorageUris.length} total objects)`,
    );

    spinner.start("Collecting bundle references from database");

    const dbUuids = new Set<string>();
    const pageSize = 500;
    let offset = 0;

    while (true) {
      const { data, pagination } = await databasePlugin.getBundles({
        limit: pageSize,
        offset,
      });

      for (const bundle of data) {
        if (bundle.storageUri) {
          const uuid = extractBundleUuid(bundle.storageUri);
          if (uuid) {
            dbUuids.add(uuid);
          }
        }
      }

      if (!pagination.hasNextPage) break;
      offset += pageSize;
    }

    spinner.stop(
      `Found ${colors.green(String(dbUuids.size))} unique bundles referenced in database`,
    );

    const orphanedEntries: { uuid: string; dirUri: string }[] = [];
    for (const [uuid, dirUri] of storageUuidToDirUri) {
      if (!dbUuids.has(uuid)) {
        orphanedEntries.push({ uuid, dirUri });
      }
    }

    if (orphanedEntries.length === 0) {
      p.outro("No orphaned storage objects found. Nothing to clean up.");
      return;
    }

    console.log("");
    p.log.step("Changes to apply:");
    p.log.warn(
      `  ${orphanedEntries.length} orphaned bundle directories will be deleted`,
    );
    console.log("");

    if (!options.yes) {
      const confirmed = await p.confirm({
        message: "Delete orphaned storage objects?",
        initialValue: false,
      });

      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Garbage collection cancelled");
        return;
      }
    }

    spinner.start(
      `Deleting ${orphanedEntries.length} orphaned bundle directories`,
    );

    let deleted = 0;
    let failed = 0;

    for (let i = 0; i < orphanedEntries.length; i += BATCH_SIZE) {
      const batch = orphanedEntries.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((entry) => storagePlugin.delete(entry.dirUri)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j]!;
        if (result.status === "fulfilled") {
          deleted++;
        } else {
          failed++;
          const entry = batch[j]!;
          p.log.error(
            `  Failed to delete ${entry.dirUri}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }
    }

    if (failed > 0) {
      spinner.stop(
        `Deleted ${deleted} of ${orphanedEntries.length} directories`,
      );
      console.log("");
      p.log.warn(`${failed} deletions failed. Check errors above.`);
    } else {
      spinner.stop(
        `Deleted ${colors.green(String(deleted))} orphaned bundle directories`,
      );
    }

    p.outro("✅ Storage garbage collection complete");
  } finally {
    await databasePlugin.onUnmount?.();
  }
}
