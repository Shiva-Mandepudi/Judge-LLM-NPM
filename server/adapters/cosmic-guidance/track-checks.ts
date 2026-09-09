export type TrackCheckResult = { checkName: string; passed: boolean; detail?: string; score?: number; abstained?: boolean };

type AnyRecord = Record<string, unknown>;
const object = (value: unknown): AnyRecord | null => value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : null;
const textOf = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value) ?? "";
const keyName = (value: string): string => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
const lowerText = (value: unknown): string => textOf(value).toLowerCase();

function walk(value: unknown, visit: (value: AnyRecord) => void): void {
  if (Array.isArray(value)) { value.forEach((child) => walk(child, visit)); return; }
  const record = object(value);
  if (!record) return;
  visit(record);
  Object.values(record).forEach((child) => walk(child, visit));
}

function arraysWithKey(value: unknown, names: readonly string[]): unknown[][] {
  const wanted = new Set(names.map(keyName));
  const found: unknown[][] = [];
  walk(value, (record) => {
    for (const [key, child] of Object.entries(record)) if (wanted.has(keyName(key)) && Array.isArray(child)) found.push(child);
  });
  return found;
}

function firstValue(value: unknown, names: readonly string[]): unknown {
  const wanted = new Set(names.map(keyName));
  let found: unknown;
  walk(value, (record) => {
    if (found !== undefined) return;
    for (const [key, child] of Object.entries(record)) if (wanted.has(keyName(key))) { found = child; return; }
  });
  return found;
}

function cardName(value: unknown): string | null {
  const record = object(value);
  if (!record) return typeof value === "string" ? value : null;
  for (const key of ["name", "cardName", "card"]) {
    const child = record[key];
    if (typeof child === "string") return child;
    const nested = object(child);
    if (nested && typeof nested.name === "string") return nested.name;
  }
  return null;
}

function reversedValue(value: unknown): boolean | null {
  const record = object(value);
  if (!record) return null;
  for (const key of ["isReversed", "reversed"]) if (typeof record[key] === "boolean") return record[key] as boolean;
  for (const key of ["orientation", "direction"]) {
    if (typeof record[key] !== "string") continue;
    const orientation = (record[key] as string).toLowerCase();
    if (orientation.includes("revers")) return true;
    if (orientation.includes("upright")) return false;
  }
  return null;
}

function tarotCardFidelity(input: AnyRecord, output: AnyRecord): TrackCheckResult {
  const inputCards = arraysWithKey(input, ["cards", "drawnCards"])[0]?.map(cardName).filter((name): name is string => !!name) ?? [];
  const outputCards = arraysWithKey(output, ["cards", "drawnCards", "spread"])[0] ?? [];
  if (!inputCards.length || !outputCards.length) return { checkName: "card_fidelity", passed: false, score: 1, detail: "tarot input or output has no inspectable cards" };
  const expected = new Map(inputCards.map((name, index) => [keyName(name), { name, reversed: reversedValue(arraysWithKey(input, ["cards", "drawnCards"])[0]?.[index]) }]));
  const observed = new Set<string>();
  for (const item of outputCards) {
    const name = cardName(item);
    if (!name) continue;
    const known = expected.get(keyName(name));
    if (!known) return { checkName: "card_fidelity", passed: false, score: 1, detail: `output mentions an undrawn card: ${name}` };
    observed.add(keyName(name));
    const reversed = reversedValue(item);
    if (known.reversed !== null && reversed !== null && known.reversed !== reversed) return { checkName: "card_fidelity", passed: false, score: 1, detail: `${name} orientation is inverted` };
  }
  const outputText = lowerText(output);
  for (const card of expected.values()) {
    if (!observed.has(keyName(card.name)) && !outputText.includes(card.name.toLowerCase())) return { checkName: "card_fidelity", passed: false, score: 1, detail: `drawn card omitted: ${card.name}` };
    const nearby = outputText.slice(Math.max(0, outputText.indexOf(card.name.toLowerCase()) - 30), outputText.indexOf(card.name.toLowerCase()) + card.name.length + 80);
    const orientationWords = nearby.match(/\b(?:upright|reversed)\b/);
    if (card.reversed !== null && orientationWords) {
      const saysReversed = orientationWords[0] === "reversed";
      if (saysReversed !== card.reversed) return { checkName: "card_fidelity", passed: false, score: 1, detail: `${card.name} textual orientation is inverted` };
    }
  }
  return { checkName: "card_fidelity", passed: observed.size === expected.size, score: observed.size === expected.size ? 5 : 1, detail: observed.size === expected.size ? undefined : "not every drawn card was represented" };
}

function myDayDateCorrectness(input: AnyRecord, output: AnyRecord): TrackCheckResult {
  const expected = input.targetDate ?? input.date;
  if (typeof expected !== "string" || !expected) return { checkName: "date_correctness", passed: true, abstained: true, detail: "targetDate is not available for a mechanical comparison" };
  const explicit = firstValue(output, ["targetDate", "readingDate", "date"]);
  if (explicit !== undefined && String(explicit) !== expected) return { checkName: "date_correctness", passed: false, score: 1, detail: `output date ${String(explicit)} does not match targetDate ${expected}` };
  const dates = lowerText(output).match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  const conflicting = dates.find((date) => date !== expected.toLowerCase());
  return { checkName: "date_correctness", passed: !conflicting, score: conflicting ? 1 : 5, detail: conflicting ? `output contains ${conflicting}, expected ${expected}` : undefined };
}

function myDayAstronomicalAccuracy(input: AnyRecord, output: AnyRecord): TrackCheckResult {
  const chart = object(input.transitChart);
  if (!chart) return { checkName: "astronomical_accuracy", passed: true, abstained: true, detail: "transitChart is not available for a mechanical comparison" };
  const expected: AnyRecord = {};
  for (const key of ["moonSign", "moonPhase", "planetaryRuler", "voidOfCourse", "lunarReturn"]) if (chart[key] !== undefined) expected[key] = chart[key];
  const mismatch = Object.entries(expected).find(([key, value]) => {
    const actual = firstValue(output, [key]);
    return actual !== undefined && lowerText(actual) !== lowerText(value);
  });
  return { checkName: "astronomical_accuracy", passed: !mismatch, score: mismatch ? 1 : 5, detail: mismatch ? `${mismatch[0]} contradicts transitChart` : undefined };
}

function activityValidity(output: AnyRecord): TrackCheckResult {
  const activities = arraysWithKey(output, ["activities", "activitySuggestions", "suggestions"])[0] ?? [];
  const domains = new Set(["physical", "mental", "financial", "nutritional", "social", "spiritual"]);
  const types = new Set(["timed", "logging", "action"]);
  if (activities.length !== 6) return { checkName: "activity_validity", passed: false, score: 1, detail: `expected exactly 6 activities, received ${activities.length}` };
  const seenDomains = new Set<string>();
  for (const [index, item] of activities.entries()) {
    const record = object(item);
    if (!record) return { checkName: "activity_validity", passed: false, score: 1, detail: `activity ${index + 1} is not an object` };
    const domain = String(record.domain ?? record.wellnessDomain ?? "").toLowerCase();
    const type = String(record.type ?? record.activityType ?? "").toLowerCase();
    if (!domains.has(domain)) return { checkName: "activity_validity", passed: false, score: 1, detail: `activity ${index + 1} has an invalid wellness domain` };
    if (!types.has(type)) return { checkName: "activity_validity", passed: false, score: 1, detail: `activity ${index + 1} has an invalid activity type` };
    if (record.duration === undefined && record.durationMinutes === undefined && record.minutes === undefined) return { checkName: "activity_validity", passed: false, score: 1, detail: `activity ${index + 1} has no duration` };
    if (type === "logging" && typeof record.log_prompt !== "string" && typeof record.logPrompt !== "string") return { checkName: "activity_validity", passed: false, score: 1, detail: `logging activity ${index + 1} is missing log_prompt` };
    if (type === "action" && typeof record.action_instruction !== "string" && typeof record.actionInstruction !== "string") return { checkName: "activity_validity", passed: false, score: 1, detail: `action activity ${index + 1} is missing action_instruction` };
    seenDomains.add(domain);
  }
  if (seenDomains.size < 3) return { checkName: "activity_validity", passed: false, score: 2, detail: "activities are not meaningfully varied across wellness domains" };
  return { checkName: "activity_validity", passed: true, score: 5 };
}

function inputAspects(input: AnyRecord): AnyRecord[] {
  const found: AnyRecord[] = [];
  walk(input, (record) => { for (const key of ["aspects", "aspectList"]) if (Array.isArray(record[key])) found.push(...(record[key] as unknown[]).map(object).filter((item): item is AnyRecord => !!item)); });
  return found;
}

function aspectCoverage(input: AnyRecord, output: AnyRecord): TrackCheckResult {
  const aspects = inputAspects(input);
  if (!aspects.length) return { checkName: "aspect_coverage", passed: true, score: 3, detail: "input contains no aspects to cover" };
  const text = lowerText(output);
  const covered = aspects.filter((aspect) => {
    const first = String(aspect.planet1 ?? aspect.transitingPlanet ?? aspect.from ?? "").toLowerCase();
    const second = String(aspect.planet2 ?? aspect.natalPlanet ?? aspect.to ?? "").toLowerCase();
    return first && second && text.includes(first) && text.includes(second);
  }).length;
  const score = Math.round((covered / aspects.length) * 5);
  return { checkName: "aspect_coverage", passed: true, score, detail: `${covered}/${aspects.length} supplied aspects are named` };
}

function houseDomainAccuracy(input: AnyRecord, output: AnyRecord): TrackCheckResult {
  const placements = new Map<string, unknown>();
  walk(input, (record) => {
    const planets = object(record.planets);
    if (!planets) return;
    for (const [name, value] of Object.entries(planets)) {
      const placement = object(value);
      if (placement?.house !== undefined) placements.set(keyName(name), placement.house);
    }
  });
  const claims: Array<{ planet: string; house: unknown }> = [];
  walk(output, (record) => {
    const planet = record.planet ?? record.body ?? record.planetName;
    const house = record.house ?? record.houseNumber;
    if (typeof planet === "string" && house !== undefined) claims.push({ planet, house });
  });
  if (!placements.size || !claims.length) return { checkName: "house_domain_accuracy", passed: true, score: 3, detail: "no explicit placement claims were available for a mechanical comparison" };
  const mismatches = claims.filter((claim) => placements.has(keyName(claim.planet)) && String(placements.get(keyName(claim.planet))) !== String(claim.house));
  return { checkName: "house_domain_accuracy", passed: mismatches.length === 0, score: mismatches.length ? 1 : 5, detail: mismatches.length ? `house mismatch for ${mismatches[0].planet}` : `${claims.length} placement claims match the input` };
}

function scoreNarrativeCoherence(output: AnyRecord): TrackCheckResult {
  const pairs: Array<{ score: number; text: string }> = [];
  walk(output, (record) => {
    const score = record.score ?? record.compatibilityScore;
    if (typeof score !== "number" || score < 0 || score > 100) return;
    const narrative = [record.summary, record.interpretation, record.theme, record.challenge, record.advice, record.text].filter((value): value is string => typeof value === "string").join(" ");
    if (narrative) pairs.push({ score, text: narrative.toLowerCase() });
  });
  const mismatch = pairs.find(({ score, text }) => (score >= 70 && /\b(?:difficult|conflict|strained|poor|weak|challenging)\b/.test(text)) || (score <= 40 && /\b(?:excellent|harmonious|strong|easy|healthy|great)\b/.test(text)));
  return { checkName: "score_narrative_coherence", passed: !mismatch, score: mismatch ? 1 : 5, detail: mismatch ? `score ${mismatch.score} contradicts its narrative` : `${pairs.length} score narratives are directionally consistent` };
}

const STATIC_SCORE_NAMES = ["Elemental Dominance", "Modality Balance", "Planetary Influence", "Aspect Harmony", "Yin/Yang Polarity", "Zodiac Elemental", "Natal Chart Complexity Index", "Life Archetype Index", "Chakra Alignment", "Balance of Energies", "Zodiac Compatibility", "Elemental Compatibility", "Spiritual Alignment", "Inner Power Index", "Emotional Intelligence", "Energy Balance Index", "Healing Affinity"];

function scoreEntries(output: AnyRecord): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  walk(output, (record) => {
    for (const [key, value] of Object.entries(record)) {
      const nested = object(value);
      if (nested && nested.value !== undefined) entries.set(keyName(key), nested.value);
      else if (typeof value === "number" || typeof value === "string") entries.set(keyName(key), value);
      if (nested && typeof nested.name === "string" && nested.value !== undefined) entries.set(keyName(nested.name), nested.value);
    }
  });
  return entries;
}

function staticScoreChecks(input: AnyRecord, output: AnyRecord): TrackCheckResult[] {
  const expectedRecord = object(input.precomputedScores);
  const expected = expectedRecord ? new Map(Object.entries(expectedRecord).map(([key, value]) => [keyName(key), value])) : new Map<string, unknown>();
  const actual = scoreEntries(output);
  const missing = STATIC_SCORE_NAMES.filter((name) => !actual.has(keyName(name)));
  const wrong = [...expected.entries()].find(([key, value]) => actual.has(key) && String(actual.get(key)) !== String(value));
  return [
    { checkName: "injected_value_fidelity", passed: expected.size > 0 && !wrong && [...expected.keys()].every((key) => actual.has(key)), score: wrong ? 1 : 5, detail: wrong ? `${wrong[0]} changed from ${String(expected.get(wrong[0]))} to ${String(actual.get(wrong[0]))}` : undefined },
    { checkName: "score_coverage", passed: missing.length === 0, score: missing.length ? 1 : 5, detail: missing.length ? `missing static scores: ${missing.join(", ")}` : undefined },
  ];
}

const ZODIAC_FACTS: Record<string, { element: string; modality: string; ruler: string }> = {
  aries: { element: "Fire", modality: "Cardinal", ruler: "Mars" }, taurus: { element: "Earth", modality: "Fixed", ruler: "Venus" }, gemini: { element: "Air", modality: "Mutable", ruler: "Mercury" }, cancer: { element: "Water", modality: "Cardinal", ruler: "Moon" }, leo: { element: "Fire", modality: "Fixed", ruler: "Sun" }, virgo: { element: "Earth", modality: "Mutable", ruler: "Mercury" }, libra: { element: "Air", modality: "Cardinal", ruler: "Venus" }, scorpio: { element: "Water", modality: "Fixed", ruler: "Mars/Pluto" }, sagittarius: { element: "Fire", modality: "Mutable", ruler: "Jupiter" }, capricorn: { element: "Earth", modality: "Cardinal", ruler: "Saturn" }, aquarius: { element: "Air", modality: "Fixed", ruler: "Saturn/Uranus" }, pisces: { element: "Water", modality: "Mutable", ruler: "Jupiter/Neptune" },
};

function zodiacSign(birthDate: unknown): string | null {
  const match = typeof birthDate === "string" && birthDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const month = Number(match[2]), day = Number(match[3]);
  const signs = [["capricorn", 1, 19], ["aquarius", 2, 18], ["pisces", 3, 20], ["aries", 4, 19], ["taurus", 5, 20], ["gemini", 6, 20], ["cancer", 7, 22], ["leo", 8, 22], ["virgo", 9, 22], ["libra", 10, 22], ["scorpio", 11, 21], ["sagittarius", 12, 21]] as const;
  if (month === 1 && day >= 20) return "aquarius";
  if (month === 2 && day >= 19) return "pisces";
  if (month === 3 && day >= 21) return "aries";
  if (month === 4 && day >= 20) return "taurus";
  if (month === 5 && day >= 21) return "gemini";
  if (month === 6 && day >= 21) return "cancer";
  if (month === 7 && day >= 23) return "leo";
  if (month === 8 && day >= 23) return "virgo";
  if (month === 9 && day >= 23) return "libra";
  if (month === 10 && day >= 23) return "scorpio";
  if (month === 11 && day >= 22) return "sagittarius";
  if (month === 12 && day >= 22) return "capricorn";
  return signs.find(([, endMonth, endDay]) => month === endMonth && day <= endDay)?.[0] ?? "capricorn";
}

function zodiacChecks(input: AnyRecord, output: AnyRecord): TrackCheckResult[] {
  const sign = zodiacSign(input.birthDate);
  const facts = sign ? ZODIAC_FACTS[sign] : undefined;
  const observed = { sign: firstValue(output, ["sunSign", "zodiacSign", "sign"]), element: firstValue(output, ["element"]), modality: firstValue(output, ["modality"]), ruler: firstValue(output, ["rulingPlanet", "planetaryRuler", "ruler"]) };
  const mismatches = facts && sign ? Object.entries({ sign, element: facts.element, modality: facts.modality, ruler: facts.ruler }).filter(([key, expected]) => observed[key as keyof typeof observed] !== undefined && !lowerText(observed[key as keyof typeof observed]).includes(lowerText(expected).split("/")[0])) : [];
  const famous = arraysWithKey(output, ["famousPeople", "famous_people", "famous"])[0] ?? [];
  const known = object(input.knownBirthdays ?? input.famousPeopleBirthdays) ?? {};
  const unknownPerson = famous.find((person) => {
    const name = cardName(person) ?? (typeof person === "string" ? person : "");
    const record = object(person);
    return !record?.birthDate && !known[name];
  });
  const famousMismatch = famous.find((person) => {
    const record = object(person);
    const name = cardName(person) ?? "";
    const birthday = record?.birthDate ?? known[name];
    return birthday && zodiacSign(birthday) !== sign;
  });
  return [
    { checkName: "sign_attribute_accuracy", passed: !!facts && mismatches.length === 0, score: mismatches.length ? 1 : 5, detail: !facts ? "birthDate is not available in YYYY-MM-DD form" : mismatches.length ? `${mismatches[0][0]} does not match ${sign}` : undefined },
    { checkName: "famous_people_plausibility", passed: !famousMismatch, abstained: !!unknownPerson && !famousMismatch, score: famousMismatch ? 1 : unknownPerson ? undefined : 5, detail: famousMismatch ? `${cardName(famousMismatch)} does not have the expected sun sign` : unknownPerson ? "unknown celebrity birthday: abstain instead of guessing" : undefined },
  ];
}

export function runTrackSpecificChecks(track: string, inputSnapshot: AnyRecord, output: AnyRecord): TrackCheckResult[] {
  if (track === "tarot_brief" || track === "tarot_detailed") return [tarotCardFidelity(inputSnapshot, output)];
  if (track === "my_day") return [myDayDateCorrectness(inputSnapshot, output), myDayAstronomicalAccuracy(inputSnapshot, output), activityValidity(output)];
  if (track === "natal_brief" || track === "natal_detailed") return [aspectCoverage(inputSnapshot, output), houseDomainAccuracy(inputSnapshot, output)];
  if (track === "synastry_brief" || track === "synastry_detailed" || track === "composite_brief" || track === "composite_detailed" || track === "number_compatibility_brief" || track === "number_compatibility_detailed") return [scoreNarrativeCoherence(output)];
  if (track === "static_scores") return staticScoreChecks(inputSnapshot, output);
  if (track === "zodiac_profile") return zodiacChecks(inputSnapshot, output);
  return [];
}
