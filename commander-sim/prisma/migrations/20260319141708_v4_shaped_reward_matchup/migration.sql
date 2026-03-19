-- AlterTable
ALTER TABLE "EpisodeStep" ADD COLUMN     "shapedReward" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "MatchupStats" (
    "id" SERIAL NOT NULL,
    "archetype1" TEXT NOT NULL,
    "archetype2" TEXT NOT NULL,
    "wins1" INTEGER NOT NULL DEFAULT 0,
    "wins2" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MatchupStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MatchupStats_archetype1_archetype2_key" ON "MatchupStats"("archetype1", "archetype2");
