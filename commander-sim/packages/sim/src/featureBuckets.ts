export type BlockerCountBucket = "0" | "1-2" | "3-4" | "5+";
export type BinaryBucket = "yes" | "no";
export type ThreatLevelBucket = "low" | "medium" | "high" | "critical";

export function bucketReadyPower(power: number): number {
  return Math.max(0, Math.floor(power / 3));
}

export function bucketIncomingDamage(damage: number): number {
  return Math.max(0, Math.floor(damage / 5));
}

export function bucketBlockerCount(count: number): BlockerCountBucket {
  if (count <= 0) return "0";
  if (count <= 2) return "1-2";
  if (count <= 4) return "3-4";
  return "5+";
}

export function bucketCanLethal(value: boolean): BinaryBucket {
  return value ? "yes" : "no";
}

export function bucketThreatLevel(score: number): ThreatLevelBucket {
  if (score >= 30) return "critical";
  if (score >= 20) return "high";
  if (score >= 10) return "medium";
  return "low";
}
