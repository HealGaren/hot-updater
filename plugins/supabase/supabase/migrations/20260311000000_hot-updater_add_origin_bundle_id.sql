-- Add origin_bundle_id column to track the original bundle resource identity.
ALTER TABLE bundles ADD COLUMN origin_bundle_id uuid;

-- Backfill: extract the UUID segment from storage_uri.
-- storage_uri format: "protocol://bucket/[basePath/]<uuid>/filename"
-- split_part with '/' gets segments; array_length - 1 is the UUID segment.
UPDATE bundles
SET origin_bundle_id = (
  split_part(storage_uri, '/', array_length(string_to_array(storage_uri, '/'), 1) - 1)
)::uuid
WHERE origin_bundle_id IS NULL AND storage_uri IS NOT NULL;

-- Fallback for any remaining rows
UPDATE bundles
SET origin_bundle_id = id
WHERE origin_bundle_id IS NULL;

-- Add NOT NULL constraint
ALTER TABLE bundles ALTER COLUMN origin_bundle_id SET NOT NULL;

-- Add index
CREATE INDEX bundles_origin_bundle_id_idx ON bundles(origin_bundle_id);

-- Update stored procedures to account for origin_bundle_id in update checks

DROP FUNCTION IF EXISTS get_update_info_by_fingerprint_hash;
DROP FUNCTION IF EXISTS get_update_info_by_app_version;

-- HotUpdater.get_update_info_by_fingerprint_hash
CREATE OR REPLACE FUNCTION get_update_info_by_fingerprint_hash (
    app_platform   platforms,
    bundle_id  uuid,
    min_bundle_id uuid,
    target_channel text,
    target_fingerprint_hash text
)
RETURNS TABLE (
    id            uuid,
    should_force_update  boolean,
    message       text,
    status        text,
    storage_uri   text,
    file_hash     text
)
LANGUAGE plpgsql
AS
$$
DECLARE
    NIL_UUID CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
    RETURN QUERY
    WITH update_candidate AS (
        SELECT
            b.id,
            b.should_force_update,
            b.message,
            'UPDATE' AS status,
            b.storage_uri,
            b.file_hash
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.origin_bundle_id > bundle_id
          AND b.origin_bundle_id > min_bundle_id
          AND b.channel = target_channel
          AND b.fingerprint_hash = target_fingerprint_hash
        ORDER BY b.origin_bundle_id DESC
        LIMIT 1
    ),
    rollback_candidate AS (
        SELECT
            b.id,
            TRUE AS should_force_update,
            b.message,
            'ROLLBACK' AS status,
            b.storage_uri,
            b.file_hash
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.origin_bundle_id < bundle_id
          AND b.origin_bundle_id > min_bundle_id
          AND b.channel = target_channel
          AND b.fingerprint_hash = target_fingerprint_hash
        ORDER BY b.origin_bundle_id DESC
        LIMIT 1
    ),
    final_result AS (
        SELECT * FROM update_candidate
        UNION ALL
        SELECT * FROM rollback_candidate
        WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
    )
    SELECT *
    FROM final_result

    UNION ALL

    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS message,
        'ROLLBACK'    AS status,
        NULL          AS storage_uri,
        NULL          AS file_hash
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND bundle_id != NIL_UUID
      AND bundle_id > min_bundle_id
      AND NOT EXISTS (
          SELECT 1
          FROM bundles b
          WHERE b.origin_bundle_id = bundle_id
            AND b.enabled = TRUE
            AND b.platform = app_platform
      );
END;
$$;


-- HotUpdater.get_update_info_by_app_version
CREATE OR REPLACE FUNCTION get_update_info_by_app_version (
    app_platform   platforms,
    app_version text,
    bundle_id  uuid,
    min_bundle_id uuid,
    target_channel text,
    target_app_version_list text[]
)
RETURNS TABLE (
    id            uuid,
    should_force_update  boolean,
    message       text,
    status        text,
    storage_uri   text,
    file_hash     text
)
LANGUAGE plpgsql
AS
$$
DECLARE
    NIL_UUID CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
    RETURN QUERY
    WITH update_candidate AS (
        SELECT
            b.id,
            b.should_force_update,
            b.message,
            'UPDATE' AS status,
            b.storage_uri,
            b.file_hash
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.origin_bundle_id > bundle_id
          AND b.origin_bundle_id > min_bundle_id
          AND b.target_app_version IN (SELECT unnest(target_app_version_list))
          AND b.channel = target_channel
        ORDER BY b.origin_bundle_id DESC
        LIMIT 1
    ),
    rollback_candidate AS (
        SELECT
            b.id,
            TRUE AS should_force_update,
            b.message,
            'ROLLBACK' AS status,
            b.storage_uri,
            b.file_hash
        FROM bundles b
        WHERE b.enabled = TRUE
          AND b.platform = app_platform
          AND b.origin_bundle_id < bundle_id
          AND b.origin_bundle_id > min_bundle_id
        ORDER BY b.origin_bundle_id DESC
        LIMIT 1
    ),
    final_result AS (
        SELECT * FROM update_candidate
        UNION ALL
        SELECT * FROM rollback_candidate
        WHERE NOT EXISTS (SELECT 1 FROM update_candidate)
    )
    SELECT *
    FROM final_result

    UNION ALL

    SELECT
        NIL_UUID      AS id,
        TRUE          AS should_force_update,
        NULL          AS message,
        'ROLLBACK'    AS status,
        NULL          AS storage_uri,
        NULL          AS file_hash
    WHERE (SELECT COUNT(*) FROM final_result) = 0
      AND bundle_id != NIL_UUID
      AND bundle_id > min_bundle_id
      AND NOT EXISTS (
          SELECT 1
          FROM bundles b
          WHERE b.origin_bundle_id = bundle_id
            AND b.enabled = TRUE
            AND b.platform = app_platform
      );
END;
$$;
