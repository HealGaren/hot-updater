-- Migration number: 0004
-- Add origin_bundle_id column to track the original bundle resource identity.
-- For directly deployed bundles, origin_bundle_id equals the bundle's own id.
-- For copy-promoted bundles, origin_bundle_id is propagated from the source.

ALTER TABLE bundles ADD COLUMN origin_bundle_id TEXT;

-- Backfill: extract the UUID segment from storage_uri.
-- storage_uri format: "protocol://bucket/[basePath/]<uuid>/filename"
-- 1. Strip filename: RTRIM(uri, non-slash-chars) -> "protocol://bucket/.../uuid/"
-- 2. Remove trailing slash -> "protocol://bucket/.../uuid"
-- 3. Strip parent path: REPLACE(dir, RTRIM(dir, non-slash-chars), '') -> "uuid"
UPDATE bundles
SET origin_bundle_id = REPLACE(
  SUBSTR(
    RTRIM(storage_uri, REPLACE(storage_uri, '/', '')),
    1,
    LENGTH(RTRIM(storage_uri, REPLACE(storage_uri, '/', ''))) - 1
  ),
  RTRIM(
    SUBSTR(
      RTRIM(storage_uri, REPLACE(storage_uri, '/', '')),
      1,
      LENGTH(RTRIM(storage_uri, REPLACE(storage_uri, '/', ''))) - 1
    ),
    REPLACE(
      SUBSTR(
        RTRIM(storage_uri, REPLACE(storage_uri, '/', '')),
        1,
        LENGTH(RTRIM(storage_uri, REPLACE(storage_uri, '/', ''))) - 1
      ),
      '/',
      ''
    )
  ),
  ''
)
WHERE origin_bundle_id IS NULL AND storage_uri IS NOT NULL;

-- Fallback for any rows where extraction failed or storage_uri is null
UPDATE bundles
SET origin_bundle_id = id
WHERE origin_bundle_id IS NULL OR origin_bundle_id = '';

-- Recreate table with NOT NULL constraint
CREATE TABLE bundles_temp (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    should_force_update INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    file_hash TEXT NOT NULL,
    git_commit_hash TEXT,
    message TEXT,
    channel TEXT NOT NULL DEFAULT 'production',
    storage_uri TEXT NOT NULL,
    target_app_version TEXT,
    fingerprint_hash TEXT,
    metadata JSONB DEFAULT '{}',
    origin_bundle_id TEXT NOT NULL,
    CHECK ((target_app_version IS NOT NULL) OR (fingerprint_hash IS NOT NULL))
);

INSERT INTO bundles_temp
SELECT id, platform, should_force_update, enabled, file_hash, git_commit_hash, message, channel, storage_uri, target_app_version, fingerprint_hash, metadata, origin_bundle_id
FROM bundles;

DROP TABLE bundles;

ALTER TABLE bundles_temp RENAME TO bundles;

CREATE INDEX bundles_target_app_version_idx ON bundles(target_app_version);
CREATE INDEX bundles_fingerprint_hash_idx ON bundles(fingerprint_hash);
CREATE INDEX bundles_channel_idx ON bundles(channel);
CREATE INDEX bundles_origin_bundle_id_idx ON bundles(origin_bundle_id);
