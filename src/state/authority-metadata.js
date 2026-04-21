import { isObject, normalizeLabel } from "../core/normalize.js";

export function collectNormalizedAuthorityImportEntries(importMeta) {
  const labelSet = new Set();
  const rawLabels = Array.isArray(importMeta?.labels) ? importMeta.labels : [];
  const rawLabelsByName = isObject(importMeta?.labelsByName) ? importMeta.labelsByName : {};
  const metaByLabel = new Map();

  for (const labelRaw of rawLabels) {
    try {
      labelSet.add(normalizeLabel(labelRaw));
    } catch {
      // Import/sync paths validate strictly; normalization drops stale malformed state.
    }
  }

  for (const [labelRaw, metaRaw] of Object.entries(rawLabelsByName)) {
    try {
      const label = normalizeLabel(labelRaw);
      labelSet.add(label);

      const rawTrimmed = String(labelRaw ?? "").trim();
      if (!metaByLabel.has(label) || rawTrimmed === label) {
        metaByLabel.set(label, isObject(metaRaw) ? metaRaw : {});
      }
    } catch {
      // Import/sync paths validate strictly; normalization drops stale malformed state.
    }
  }

  return {
    labels: [...labelSet].toSorted((a, b) => a.localeCompare(b)),
    metaByLabel,
  };
}
