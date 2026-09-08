import type { Stratifier } from "../../core/contracts/ports.js";

// Track mapping already derives the stable stratum in the datasource. This port
// preserves the core boundary without duplicating product-specific lookup logic.
export const cosmicGuidanceStratifier: Stratifier = {
  stratumOf(raw) {
    return raw.stratum;
  },
};
