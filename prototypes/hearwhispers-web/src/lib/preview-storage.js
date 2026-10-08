import { exampleProduct } from "../data.js";

export const storageKey = "hearwhispers-preview-v1";

// Legacy identifiers are confined to this read-only migration. Keep the old
// storage entry as a backup; all current writes use the HearWhispers key.
const legacyStorageKey = "stygrnded-preview-v1";
const legacyProductId = "stygrnded";
const legacyProductName = "StyGrnded";

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

function normalizeState(saved) {
  if (!isRecord(saved) || !Array.isArray(saved.products) ||
      !saved.products.every(product => isRecord(product) && typeof product.id === "string" && typeof product.name === "string") ||
      !isRecord(saved.review) || !isRecord(saved.drafts)) return null;

  return {
    ...saved,
    products: saved.products.map(product => {
      if (product.id !== legacyProductId && product.id !== exampleProduct.id) return product;
      return {
        ...product,
        id: exampleProduct.id,
        name: product.example && product.name === legacyProductName ? exampleProduct.name : product.name,
      };
    }),
  };
}

export function loadPreviewState(storage) {
  for (const key of [storageKey, legacyStorageKey]) {
    try {
      const saved = normalizeState(JSON.parse(storage.getItem(key)));
      if (saved) return saved;
    } catch { /* Try the legacy backup if this entry is unavailable or invalid. */ }
  }
  return { products: [{ ...exampleProduct }], review: {}, drafts: {} };
}
