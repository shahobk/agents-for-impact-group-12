-- BigQuery named parameter: @posting_text
-- Brute force is intentional: this corpus is far below the useful index size.
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
LIMIT 30;
