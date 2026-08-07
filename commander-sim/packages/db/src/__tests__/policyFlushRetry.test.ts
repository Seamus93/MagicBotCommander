import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatternStore } from "../../../sim/src/patterns.js";

const mocks = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  upsertMock: vi.fn((args) => args),
}));

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(() => ({
    $transaction: mocks.transactionMock,
    $disconnect: vi.fn(),
    policyRecord: {
      upsert: mocks.upsertMock,
    },
  })),
  Prisma: {
    JsonNull: null,
  },
}));

vi.mock("@game-state/stateDigest", () => ({
  buildStateDigest: vi.fn((state) => state),
}));

describe("policy DB flush retry", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.transactionMock.mockReset();
    mocks.upsertMock.mockClear();
    vi.stubEnv("POLICY_FLUSH_RETRY_BASE_MS", "1");
  });

  it("retries Prisma P1001 and marks dirty records clean after success", async () => {
    vi.stubEnv("POLICY_FLUSH_RETRIES", "2");
    mocks.transactionMock
      .mockRejectedValueOnce(Object.assign(new Error("Can't reach database server"), { code: "P1001" }))
      .mockResolvedValueOnce([]);
    const { upsertPolicyRecords } = await import("../db.js");
    const store = new PatternStore();
    store.observe("pattern", "CAST_SPELL:Murder", 2);

    const stats = await upsertPolicyRecords(7, store, { dirtyOnly: true });

    expect(mocks.transactionMock).toHaveBeenCalledTimes(2);
    expect(stats.retryCount).toBe(1);
    expect(store.dirtyCount).toBe(0);
  });

  it("keeps dirty records after retry exhaustion", async () => {
    vi.stubEnv("POLICY_FLUSH_RETRIES", "0");
    mocks.transactionMock.mockRejectedValue(Object.assign(new Error("temporary unavailable"), { code: "P1001" }));
    const { upsertPolicyRecords } = await import("../db.js");
    const store = new PatternStore();
    store.observe("pattern", "PLAY_LAND:Forest", 1);

    await expect(upsertPolicyRecords(null, store, { dirtyOnly: true })).rejects.toMatchObject({
      name: "PolicyFlushError",
      dirtyRecordCount: 1,
    });
    expect(store.dirtyCount).toBe(1);
  });

  it("uses absolute upsert values so retrying the same batch is idempotent", async () => {
    vi.stubEnv("POLICY_FLUSH_RETRIES", "1");
    mocks.transactionMock
      .mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "P1001" }))
      .mockResolvedValueOnce([]);
    const { upsertPolicyRecords } = await import("../db.js");
    const store = new PatternStore();
    store.observe("pattern", "CAST_SPELL:Murder", 3);

    await upsertPolicyRecords(null, store, { dirtyOnly: true });

    const secondAttemptOps = mocks.transactionMock.mock.calls[1][0];
    expect(secondAttemptOps).toHaveLength(1);
    expect(secondAttemptOps[0].update.visits).toBe(1);
    expect(secondAttemptOps[0].update.score).toBe(3);
    expect(secondAttemptOps[0].update.visits).not.toEqual({ increment: 1 });
    expect(secondAttemptOps[0].update.score).not.toEqual({ increment: 3 });
  });
});
