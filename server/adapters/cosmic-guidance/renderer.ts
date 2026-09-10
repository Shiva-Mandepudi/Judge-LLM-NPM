import type { Renderer, RawRow } from "../../core/contracts/ports.js";
import type { RenderedContent } from "../../core/contracts/rendered-content.js";
import type { TrackSpec } from "../../core/config/schema.js";

const SVG = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
const IMAGE_DATA = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const PRIVATE_KEY = /^(person\d+name|birth(name|date|time|city|country)|city|country|nation|location|date|time)$/i;
const ZODIAC_NAMES: Record<string, string> = { Ari: "Aries", Tau: "Taurus", Gem: "Gemini", Can: "Cancer", Leo: "Leo", Vir: "Virgo", Lib: "Libra", Sco: "Scorpio", Sag: "Sagittarius", Cap: "Capricorn", Aqu: "Aquarius", Pis: "Pisces" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function chartPlacement(value: unknown): Record<string, unknown> {
  const placement = record(value) ?? {};
  return { ...placement, ...(typeof placement.sign === "string" ? { sign: ZODIAC_NAMES[placement.sign] ?? placement.sign } : {}) };
}

function canonicalChartInput(value: unknown): unknown {
  const input = record(value);
  if (!input || !record(input.chartDetails)) return value;
  const details = input.chartDetails as Record<string, unknown>;
  const chartData = record(details.chart_data) ?? {};
  const sourcePlanets = chartData.planets ?? details.planets;
  const sourceHouses = chartData.houses ?? details.houses;
  const sourceAspects = details.aspects ?? chartData.aspects;
  const planetRecord = record(sourcePlanets);
  const houseRecord = record(sourceHouses);
  const planets = Array.isArray(sourcePlanets)
    ? Object.fromEntries(sourcePlanets.filter((item) => record(item)?.name).map((item) => {
      const placement = chartPlacement(item);
      return [String(placement.name), Object.fromEntries(Object.entries(placement).filter(([key]) => key !== "name"))];
    }))
    : planetRecord ? Object.fromEntries(Object.entries(planetRecord).map(([name, item]) => [name, chartPlacement(item)])) : {};
  const houses = Array.isArray(sourceHouses)
    ? Object.fromEntries(sourceHouses.filter((item) => record(item)?.number !== undefined).map((item) => {
      const house = chartPlacement(item);
      return [String(house.number), Object.fromEntries(Object.entries(house).filter(([key]) => key !== "number"))];
    }))
    : houseRecord ? Object.fromEntries(Object.entries(houseRecord).map(([number, item]) => [number, chartPlacement(item)])) : {};
  const aspects = Array.isArray(sourceAspects)
    ? Object.fromEntries(sourceAspects.filter((item) => record(item)?.planet1 && record(item)?.planet2).map((item) => {
      const aspect = item as Record<string, unknown>;
      return [`${String(aspect.planet1)}-${String(aspect.planet2)}`, { aspect_type: aspect.aspect_type, precision: aspect.precision }];
    }))
    : record(sourceAspects) ?? {};
  const topLevel = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "chartDetails"));
  return { ...topLevel, planets, houses, aspects, ascendant: chartData.ascendant ?? details.ascendant ?? null, mc: chartData.mc ?? details.mc ?? null };
}

export function removeImageBlobs(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SVG, "[image omitted]").replace(IMAGE_DATA, "[image omitted]");
  if (Array.isArray(value)) return value.map(removeImageBlobs);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, removeImageBlobs(child)]));
  }
  return value;
}

function collectPrivateValues(value: unknown, path = "", result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((child, index) => collectPrivateValues(child, `${path}[${index}]`, result));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key) || (key === "name" && !path.includes("planets") && !path.includes("cards"))) {
        if (typeof child === "string" && child.length > 2) result.add(child);
      } else collectPrivateValues(child, path ? `${path}.${key}` : key, result);
    }
  }
  return result;
}

function redactPrivateContent(value: unknown, privateValues: ReadonlySet<string>, path = ""): unknown {
  if (typeof value === "string") {
    return [...privateValues].sort((a, b) => b.length - a.length).reduce((text, privateValue) => text.split(privateValue).join("[redacted]"), value);
  }
  if (Array.isArray(value)) return value.map((child, index) => redactPrivateContent(child, privateValues, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, child]) => {
      if (PRIVATE_KEY.test(key) || (key === "name" && !path.includes("planets") && !path.includes("cards"))) return [];
      return [[key, redactPrivateContent(child, privateValues, path ? `${path}.${key}` : key)]];
    }));
  }
  return value;
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value as string | number | boolean | null | undefined;
  return undefined;
}

function flatten(value: unknown, path = "", fields: Record<string, string | number | boolean | null> = {}): Record<string, string | number | boolean | null> {
  const primitive = scalar(value);
  if (primitive !== undefined && path) fields[path] = primitive;
  else if (Array.isArray(value)) value.forEach((child, index) => flatten(child, `${path}[${index}]`, fields));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
      flatten(child, path ? `${path}.${key}` : key, fields);
    }
  }
  return fields;
}

function addCanonicalChartFields(input: unknown, fields: Record<string, string | number | boolean | null>): void {
  const chart = record(input);
  if (!chart) return;
  const planets = record(chart.planets);
  for (const [name, value] of Object.entries(planets ?? {})) {
    const placement = record(value);
    if (!placement) continue;
    const summary = [placement.sign, placement.house, placement.position].filter((item) => item !== undefined && item !== null).join(", ");
    if (summary) fields[`planets.${name}`] = summary;
  }
  const aspects = record(chart.aspects);
  for (const [name, value] of Object.entries(aspects ?? {})) {
    const aspect = record(value);
    if (!aspect) continue;
    const summary = [aspect.aspect_type, aspect.precision === undefined ? undefined : `precision ${aspect.precision}`].filter((item) => item !== undefined && item !== null).join(", ");
    if (summary) fields[`aspects[${name}]`] = summary;
  }
  const houses = record(chart.houses);
  for (const [number, value] of Object.entries(houses ?? {})) {
    const house = record(value);
    if (!house) continue;
    const summary = [house.sign, house.position ?? house.cusp].filter((item) => item !== undefined && item !== null).join(", position ");
    if (summary) {
      fields[`houses.${number}`] = summary;
      fields[`houses[${number}]`] = summary;
    }
  }
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function sectionize(value: unknown, root: string): Array<{ name: string; path: string; text: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{ name: root, path: root, text: text(value) }];
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => ({
    name,
    path: `${root}.${name}`,
    text: text(child),
  }));
}

function renderPart(label: string, value: unknown): string {
  return `## ${label}\n${sectionize(value, label.toLowerCase()).map((section) => `### ${section.name}\n${section.text}`).join("\n\n")}`;
}

function renderForShape(raw: RawRow): RenderedContent {
  const privateValues = collectPrivateValues(raw.inputSnapshot);
  const input = redactPrivateContent(removeImageBlobs(canonicalChartInput(raw.inputSnapshot)), privateValues);
  const candidate = redactPrivateContent(removeImageBlobs(raw.candidateOutput), privateValues);
  const silver = raw.silverOutput === null ? null : redactPrivateContent(removeImageBlobs(raw.silverOutput), privateValues);
  const sections = [
    ...sectionize(input, "input"),
    ...sectionize(candidate, "candidate"),
    ...(silver === null ? [] : sectionize(silver, "silver")),
  ];
  const fields = flatten(input);
  addCanonicalChartFields(input, fields);
  return {
    sections,
    fields,
    text: [renderPart("INPUT DATA", input), renderPart("READING UNDER REVIEW", candidate), ...(silver === null ? [] : [renderPart("SILVER REFERENCE", silver)])].join("\n\n"),
  };
}

/** Shared deterministic implementation; registry entries are explicit per configured shape. */
export const cosmicGuidanceRenderer: Renderer = { render: renderForShape };

const shapeRenderers = new Map<string, Renderer>([
  ...["natal", "transit", "synastry", "composite", "number_compatibility", "numerology", "tarot", "my_day", "static_scores", "zodiac_profile"]
    .map((shape) => [shape, { render: renderForShape }] as const),
]);

export function rendererRegistry(tracks: readonly TrackSpec[]): ReadonlyMap<string, Renderer> {
  return new Map(tracks.map((track) => {
    const renderer = shapeRenderers.get(track.renderer);
    if (!renderer) throw new Error(`Unsupported production renderer shape: ${track.renderer}`);
    return [track.track, renderer];
  }));
}
