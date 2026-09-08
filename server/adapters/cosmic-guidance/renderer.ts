import type { Renderer, RawRow } from "../../core/contracts/ports.js";
import type { RenderedContent } from "../../core/contracts/rendered-content.js";
import type { TrackSpec } from "../../core/config/schema.js";

const SVG = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
const IMAGE_DATA = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
const PRIVATE_KEY = /^(person\d+name|birth(name|date|time|city|country)|city|country|nation|location|date|time)$/i;

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
  const input = redactPrivateContent(removeImageBlobs(raw.inputSnapshot), privateValues);
  const candidate = redactPrivateContent(removeImageBlobs(raw.candidateOutput), privateValues);
  const silver = raw.silverOutput === null ? null : redactPrivateContent(removeImageBlobs(raw.silverOutput), privateValues);
  const sections = [
    ...sectionize(input, "input"),
    ...sectionize(candidate, "candidate"),
    ...(silver === null ? [] : sectionize(silver, "silver")),
  ];
  return {
    sections,
    fields: flatten(input),
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
