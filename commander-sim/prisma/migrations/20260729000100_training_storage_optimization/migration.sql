ALTER TABLE "SimulationRun"
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "aggregateMetrics" JSONB,
ADD COLUMN IF NOT EXISTS "storageStats" JSONB;

ALTER TABLE "PolicyRecord"
ADD COLUMN IF NOT EXISTS "rewardSquaredSum" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "winCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "lossCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "PolicyRecord"
SET "rewardSquaredSum" = CASE
  WHEN "rewardSquaredSum" IS NULL AND "visits" > 0 THEN (("score" / "visits") * ("score" / "visits") * "visits")
  WHEN "rewardSquaredSum" IS NULL THEN 0
  ELSE "rewardSquaredSum"
END;
