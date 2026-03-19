-- CreateTable
CREATE TABLE "SimulationRun" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "episodes" INTEGER NOT NULL,
    "players" INTEGER NOT NULL,
    "maxTurns" INTEGER,
    "policyPath" TEXT,
    "archetypes" JSONB,
    "deckIds" JSONB,

    CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Archetype" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "goal" TEXT,
    "flow" TEXT,
    "keywords" TEXT,
    "wincons" TEXT,
    "weakness" TEXT,
    "tags" TEXT,

    CONSTRAINT "Archetype_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deck" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceUrl" TEXT,
    "name" TEXT,
    "commander" TEXT,
    "cards" JSONB NOT NULL,
    "cardHash" TEXT NOT NULL,

    CONSTRAINT "Deck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" INTEGER NOT NULL,
    "index" INTEGER NOT NULL,
    "winnerIndex" INTEGER,
    "turnCount" INTEGER,
    "finalState" JSONB,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpisodeStep" (
    "id" SERIAL NOT NULL,
    "episodeId" INTEGER NOT NULL,
    "step" INTEGER NOT NULL,
    "playerIndex" INTEGER NOT NULL,
    "agentId" TEXT,
    "actionType" TEXT NOT NULL,
    "card" TEXT,
    "state" JSONB NOT NULL,
    "availableActions" JSONB,
    "decisionMeta" JSONB,
    "reward" INTEGER,
    "winnerIndex" INTEGER,

    CONSTRAINT "EpisodeStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyRecord" (
    "id" SERIAL NOT NULL,
    "pattern" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "visits" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" INTEGER,

    CONSTRAINT "PolicyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Archetype_name_key" ON "Archetype"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Deck_cardHash_key" ON "Deck"("cardHash");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_runId_index_key" ON "Episode"("runId", "index");

-- CreateIndex
CREATE INDEX "EpisodeStep_episodeId_idx" ON "EpisodeStep"("episodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyRecord_pattern_actionKey_key" ON "PolicyRecord"("pattern", "actionKey");

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SimulationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeStep" ADD CONSTRAINT "EpisodeStep_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyRecord" ADD CONSTRAINT "PolicyRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SimulationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
