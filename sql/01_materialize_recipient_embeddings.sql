-- Embed only semantic profile prose. Identifiers, coordinates, capacity, income,
-- and clock values remain structured beside the vector for deterministic checks.
-- Run with the project containing a4i_food set as the BigQuery default project.
CREATE OR REPLACE TABLE `a4i_food.recipient_embeddings` AS
SELECT
  * EXCEPT (embedded),
  embedded.result AS embedding
FROM (
  SELECT
    r.*,
    AI.EMBED(r.profile_text, endpoint => 'gemini-embedding-2') AS embedded
  FROM `a4i_food.recipients` AS r
)
WHERE embedded.status = '';
