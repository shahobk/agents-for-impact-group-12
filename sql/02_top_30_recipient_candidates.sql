-- BigQuery named parameter: @posting_text
-- Brute force is intentional: this corpus is far below the useful index size.
-- Recipient coordinates are approximate ZIP centroids. The nearest tract and
-- its need signals are correspondingly approximate and must be labeled as such.
WITH vector_candidates AS (
  SELECT
    base.recipient_id,
    base.name,
    base.street,
    base.city,
    base.state,
    base.zip_code,
    base.ein,
    base.ntee_code,
    base.archetype,
    base.archetype_label,
    base.cold_storage,
    base.frozen_storage,
    base.loading_dock,
    base.refrigerated_transport,
    base.max_pallets,
    base.pickup_window_hours,
    base.weekly_households,
    base.reported_income,
    base.populations_served,
    base.service_days,
    base.profile_text,
    base.profile_source,
    base.latitude,
    base.longitude,
    distance AS semantic_distance
  FROM VECTOR_SEARCH(
    TABLE `a4i_food.recipient_embeddings`,
    'embedding',
    (SELECT AI.EMBED(@posting_text, endpoint => 'gemini-embedding-2').result AS embedding),
    top_k => 30,
    distance_type => 'COSINE',
    options => '{"use_brute_force":true}'
  )
  ORDER BY semantic_distance
  LIMIT 30
),
nearest_tract AS (
  SELECT
    candidate.*,
    tract.geo_id AS tract_geo_id,
    tract.poverty_rate AS tract_poverty_rate,
    tract.no_vehicle_rate AS tract_no_vehicle_rate,
    tract.assistance_rate AS tract_assistance_rate,
    ROW_NUMBER() OVER (
      PARTITION BY candidate.recipient_id
      ORDER BY ST_DISTANCE(
        ST_GEOGPOINT(candidate.longitude, candidate.latitude),
        ST_GEOGPOINT(tract.tract_lon, tract.tract_lat)
      )
    ) AS tract_rank
  FROM vector_candidates AS candidate
  LEFT JOIN `a4i_food.tract_demographics` AS tract
    ON candidate.latitude IS NOT NULL
    AND candidate.longitude IS NOT NULL
    AND tract.tract_lat IS NOT NULL
    AND tract.tract_lon IS NOT NULL
)
SELECT
  * EXCEPT (tract_rank),
  CASE
    WHEN tract_poverty_rate IS NOT NULL AND tract_no_vehicle_rate IS NOT NULL
    THEN LEAST(1.0, GREATEST(
      0.0,
      tract_poverty_rate * 0.6 + tract_no_vehicle_rate * 0.4
    ))
    ELSE NULL
  END AS need_score,
  IF(
    tract_geo_id IS NULL,
    NULL,
    'nearest_census_tract_to_approximate_zip_centroid'
  ) AS need_evidence_source
FROM nearest_tract
WHERE tract_rank = 1
ORDER BY semantic_distance;
