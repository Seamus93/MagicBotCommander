import { describe, expect, it } from "vitest";
import { buildSeatsFromControllers } from "../state/stateSerializer";
import {
  authenticateSeatRecipient,
  buildSeatCredentialState,
  releaseSeatConnection,
  type SeatCredential,
} from "./seatOwnership";

function credentialsForHumanSeats(controllers: Array<"human" | "ai">): SeatCredential[] {
  return buildSeatsFromControllers(controllers)
    .filter((seat) => seat.controller === "human")
    .map((seat) => ({
      seatId: seat.id,
      playerId: seat.playerId,
      token: `token-${seat.playerId}`,
    }));
}

describe("seat ownership", () => {
  it.each([
    [["human", "ai", "ai", "ai"] as const, ["northWest"]],
    [["human", "human", "ai", "ai"] as const, ["northWest", "northEast"]],
    [["human", "human", "human", "ai"] as const, ["northWest", "northEast", "southEast"]],
    [["human", "human", "human", "human"] as const, ["northWest", "northEast", "southEast", "southWest"]],
  ])("authenticates each occupied human seat for %j", (controllers, expectedSeatIds) => {
    const seats = buildSeatsFromControllers([...controllers]);
    const credentials = buildSeatCredentialState(credentialsForHumanSeats([...controllers]));

    for (const seatId of expectedSeatIds) {
      const seat = seats.find((candidate) => candidate.id === seatId);
      const result = authenticateSeatRecipient({
        seats,
        credentials,
        connectionId: `conn-${seatId}`,
        recipient: {
          role: "player",
          seatId: seat?.id,
          playerId: seat?.playerId,
          playerToken: `token-${seat?.playerId}`,
        },
      });

      expect(result).toMatchObject({
        ok: true,
        recipient: { role: "player", seatId, playerId: seat?.playerId },
      });
    }
  });

  it("rejects duplicate live clients for the same human seat, then allows reconnect after release", () => {
    const seats = buildSeatsFromControllers(["human", "human", "ai", "ai"]);
    const credentials = buildSeatCredentialState(credentialsForHumanSeats(["human", "human", "ai", "ai"]));
    const northWest = seats[0];
    const recipient = {
      role: "player" as const,
      seatId: northWest.id,
      playerId: northWest.playerId,
      playerToken: "token-p0",
    };

    expect(authenticateSeatRecipient({ seats, credentials, connectionId: "conn-a", recipient }).ok).toBe(true);
    expect(authenticateSeatRecipient({ seats, credentials, connectionId: "conn-b", recipient })).toMatchObject({
      ok: false,
      code: "SEAT_ALREADY_CONNECTED",
    });

    releaseSeatConnection(credentials, "conn-a");
    expect(authenticateSeatRecipient({ seats, credentials, connectionId: "conn-b", recipient }).ok).toBe(true);
  });

  it("rejects wrong credentials and non-human seats", () => {
    const seats = buildSeatsFromControllers(["human", "ai", "ai", "ai"]);
    const credentials = buildSeatCredentialState(credentialsForHumanSeats(["human", "ai", "ai", "ai"]));

    expect(authenticateSeatRecipient({
      seats,
      credentials,
      connectionId: "conn-a",
      recipient: { role: "player", seatId: "northWest", playerId: "p0", playerToken: "wrong" },
    })).toMatchObject({ ok: false, code: "SEAT_CREDENTIAL_INVALID" });

    expect(authenticateSeatRecipient({
      seats,
      credentials,
      connectionId: "conn-b",
      recipient: { role: "player", seatId: "northEast", playerId: "p1", playerToken: "token-p1" },
    })).toMatchObject({ ok: false, code: "SEAT_NOT_HUMAN" });
  });

  it("allows table and debug spectators without seat ownership", () => {
    const seats = buildSeatsFromControllers(["human", "human", "ai", "ai"]);
    const credentials = buildSeatCredentialState(credentialsForHumanSeats(["human", "human", "ai", "ai"]));

    expect(authenticateSeatRecipient({
      seats,
      credentials,
      connectionId: "table",
      recipient: { role: "table", seatId: "northWest", playerId: "p0", playerToken: "wrong" },
    })).toMatchObject({ ok: true, recipient: { role: "table" } });

    expect(authenticateSeatRecipient({
      seats,
      credentials,
      connectionId: "debug",
      recipient: { role: "debug" },
    })).toMatchObject({ ok: true, recipient: { role: "debug" } });
  });
});
