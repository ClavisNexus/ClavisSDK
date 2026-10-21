import { SetupApiError } from "./org-api.js";

/** The regions an app accepts new connections from. They are stored in this order. */
export const APP_REGIONS = ["JP", "US", "GB", "EEA"] as const;
export type AppRegion = (typeof APP_REGIONS)[number];

type Refusal = { ok: false; error: string };

const CHOICE_HINT = "Pass --regions with one or more of JP, US, GB, EEA (comma-separated), or --all (MCP: regions or all: true).";

function isAppRegion(value: string): value is AppRegion {
  return (APP_REGIONS as readonly string[]).includes(value);
}

/**
 * Settle on one way of choosing the regions. `all` means every region Clavis accepts, and returns
 * null. Neither given, or both, is refused.
 */
export function chooseAppRegions(input: {
  regions?: readonly string[];
  all?: boolean;
}): { ok: true; regions: readonly string[] | null } | Refusal {
  const listed = input.regions !== undefined;
  if (input.all === true && listed) {
    return { ok: false, error: `regions_conflict — pass either regions or all, not both. ${CHOICE_HINT}` };
  }
  if (input.all === true) return { ok: true, regions: null };
  if (!listed) return { ok: false, error: `regions_required — ${CHOICE_HINT}` };
  return { ok: true, regions: input.regions! };
}

/**
 * Read the accepted regions. Null removes the list.
 * White space is trimmed, the codes are upper-cased, and they are ordered as in {@link APP_REGIONS}.
 * An empty list, a duplicate, and a region it does not know are refused.
 */
export function readAppRegionsInput(
  raw: readonly string[] | null,
): { ok: true; regions: AppRegion[] | null } | Refusal {
  if (raw === null) return { ok: true, regions: null };
  const codes = raw.map((code) => code.trim().toUpperCase());
  if (codes.length === 0 || new Set(codes).size !== codes.length || !codes.every(isAppRegion)) {
    return { ok: false, error: `regions_invalid — ${CHOICE_HINT}` };
  }
  return { ok: true, regions: APP_REGIONS.filter((region) => codes.includes(region)) };
}

/** Whether this matches the regions already stored. Both null, meaning unset, counts as the same. */
export function sameAppRegions(stored: readonly string[] | null | undefined, next: readonly AppRegion[] | null): boolean {
  const current = stored ?? null;
  if (current === null || next === null) return current === next;
  return current.length === next.length && current.every((region, i) => region === next[i]);
}

export function regionNotOpenRefusal(closed: readonly string[], selectable: readonly string[] | null): Refusal {
  const open = selectable && selectable.length > 0 ? ` Regions you can choose now: ${selectable.join(", ")}.` : "";
  return {
    ok: false,
    error: `region_not_open — Clavis is not accepting new connections from ${closed.join(", ")} right now, so an App cannot accept them.${open}`,
  };
}

export function appDisabledRefusal(): Refusal {
  return { ok: false, error: "app_disabled — this App is disabled, so its regions cannot be changed." };
}

/** Turn the API's reason for refusing a region save into wording that says what happened. Anything else is null. */
export function appRegionsRefusal(e: unknown, regions: readonly string[]): Refusal | null {
  if (!(e instanceof SetupApiError)) return null;
  switch (e.code) {
    case "REGION_NOT_OPEN":
      return regionNotOpenRefusal(regions, null);
    case "REGIONS_INVALID":
      return { ok: false, error: `regions_invalid — ${CHOICE_HINT}` };
    case "APP_DISABLED":
      return appDisabledRefusal();
    case "FORBIDDEN":
      return { ok: false, error: "forbidden — only an owner or admin of the Org can change the App's regions." };
    default:
      return null;
  }
}
