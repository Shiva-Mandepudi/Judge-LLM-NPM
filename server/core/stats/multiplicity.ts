export function benjaminiHochberg(pValues: Record<string, number>): Record<string, number> {
  const entries = Object.entries(pValues).sort((a, b) => a[1] - b[1]); const adjusted: Record<string, number> = {}; let previous = 1;
  for (let index = entries.length - 1; index >= 0; index--) { const [key, p] = entries[index]; previous = Math.min(previous, (p * entries.length) / (index + 1)); adjusted[key] = Math.min(1, previous); }
  return adjusted;
}
