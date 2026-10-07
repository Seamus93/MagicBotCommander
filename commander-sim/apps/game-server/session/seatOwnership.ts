import type { Seat, SessionRecipient } from "../../../packages/game-state/src/session";
import type { RecipientAuthResult } from "./SessionManager.js";

export interface SeatCredential {
  seatId: Seat["id"];
  playerId: string;
  token: string;
}

export type SeatCredentialState = Map<Seat["id"], {
  playerId: string;
  token: string;
  activeConnectionId?: string;
}>;

export function buildSeatCredentialState(credentials: SeatCredential[] = []): SeatCredentialState {
  return new Map(credentials.map((credential) => [
    credential.seatId,
    {
      playerId: credential.playerId,
      token: credential.token,
    },
  ]));
}

export function authenticateSeatRecipient(params: {
  recipient: SessionRecipient;
  connectionId: string;
  seats: Seat[];
  credentials: SeatCredentialState;
}): RecipientAuthResult {
  const { recipient, connectionId, seats, credentials } = params;

  if (recipient.role === "debug" || recipient.role === "table") {
    return { ok: true, recipient: { role: recipient.role } };
  }

  if (recipient.role !== "player") {
    return { ok: false, code: "INVALID_ROLE", message: "Unsupported session role." };
  }

  const seat = seats.find((candidate) => candidate.id === recipient.seatId);
  const credentialSeatEntry = Array.from(credentials.entries()).find(([, credential]) =>
    credential.playerId === recipient.playerId && credential.token === recipient.playerToken
  );
  if (credentialSeatEntry && (!seat || seat.id !== credentialSeatEntry[0])) {
    const [seatId, credential] = credentialSeatEntry;
    const credentialSeat = seats.find((candidate) => candidate.id === seatId);
    if (!credentialSeat || credentialSeat.controller !== "human") {
      return { ok: false, code: "SEAT_NOT_HUMAN", message: "Requested seat is not occupied by a human player." };
    }
    if (credential.activeConnectionId && credential.activeConnectionId !== connectionId) {
      return { ok: false, code: "SEAT_ALREADY_CONNECTED", message: "This human seat is already controlled by another connection." };
    }
    credential.activeConnectionId = connectionId;
    return {
      ok: true,
      recipient: { role: "player", seatId: credentialSeat.id, playerId: credential.playerId },
    };
  }

  if (!seat || seat.controller !== "human") {
    return { ok: false, code: "SEAT_NOT_HUMAN", message: "Requested seat is not occupied by a human player." };
  }

  const credential = credentials.get(seat.id);
  if (credential) {
    if (recipient.playerId !== credential.playerId || recipient.playerToken !== credential.token) {
      return { ok: false, code: "SEAT_CREDENTIAL_INVALID", message: "Player credentials do not match this seat." };
    }
    if (credential.activeConnectionId && credential.activeConnectionId !== connectionId) {
      return { ok: false, code: "SEAT_ALREADY_CONNECTED", message: "This human seat is already controlled by another connection." };
    }
    credential.activeConnectionId = connectionId;
    return {
      ok: true,
      recipient: { role: "player", seatId: seat.id, playerId: credential.playerId },
    };
  }

  if (recipient.playerId && recipient.playerId !== seat.playerId) {
    return { ok: false, code: "PLAYER_ID_MISMATCH", message: "Player id does not match this seat." };
  }
  return {
    ok: true,
    recipient: { role: "player", seatId: seat.id, playerId: seat.playerId },
  };
}

export function releaseSeatConnection(credentials: SeatCredentialState, connectionId: string): void {
  for (const credential of credentials.values()) {
    if (credential.activeConnectionId === connectionId) {
      delete credential.activeConnectionId;
    }
  }
}
