import crypto from "node:crypto";

export type BlindLabel = "A" | "B";
export type Arm = "baseline" | "candidate";
export type BlindLabelMap = Record<BlindLabel, Arm>;

// Randomized per job so a judge model can never learn "A is always baseline"
// across a batch — position/order bias control per the framework's §2.1.
export function assignBlindLabels(idempotencyKey: string): BlindLabelMap {
  const bit = crypto.createHash("sha256").update(idempotencyKey).digest()[0] & 1;
  return bit === 0 ? { A: "baseline", B: "candidate" } : { A: "candidate", B: "baseline" };
}

export function armForLabel(map: BlindLabelMap, label: BlindLabel): Arm {
  return map[label];
}

export function labelForArm(map: BlindLabelMap, arm: Arm): BlindLabel {
  return map.A === arm ? "A" : "B";
}
