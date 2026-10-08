import test from "node:test";
import assert from "node:assert/strict";
import { loadPreviewState, storageKey } from "../src/lib/preview-storage.js";
import { conversations, exampleProduct } from "../src/data.js";

const legacyKey = "stygrnded-preview-v1";
const legacyState = {
  products: [
    { id: "stygrnded", name: "StyGrnded", example: true, website: "https://example.com", description: "Existing details" },
    { id: "custom-product", name: "My product", example: false, website: "https://custom.example" },
  ],
  review: { "first-users": "saved", "finding-distribution": "dismissed" },
  drafts: { "first-users": "Keep this draft exactly." },
};
const storage = entries => ({ getItem: key => entries[key] ?? null });

test("legacy data migrates product references without losing drafts, statuses, or custom products", () => {
  const original = JSON.stringify(legacyState);
  const result = loadPreviewState(storage({ [legacyKey]: original }));
  assert.deepEqual(result, {
    ...legacyState,
    products: [{ ...legacyState.products[0], id: "hearwhispers", name: "HearWhispers" }, legacyState.products[1]],
  });
  assert.ok(conversations.every(item => result.products.some(product => product.id === item.productId)));
  assert.equal(JSON.stringify(legacyState), original);
});

test("current HearWhispers data takes precedence and is stable on subsequent loads", () => {
  const current = { products: [exampleProduct], review: { "first-users": "new" }, drafts: { "first-users": "Newer draft" } };
  const result = loadPreviewState(storage({ [storageKey]: JSON.stringify(current), [legacyKey]: JSON.stringify(legacyState) }));
  assert.deepEqual(result, current);
  assert.deepEqual(loadPreviewState(storage({ [storageKey]: JSON.stringify(result) })), current);
});

test("renaming the example ID preserves a user-edited product name and details", () => {
  const edited = { ...legacyState, products: [{ ...legacyState.products[0], name: "My renamed workspace" }] };
  const result = loadPreviewState(storage({ [legacyKey]: JSON.stringify(edited) }));
  assert.deepEqual(result.products[0], { ...edited.products[0], id: "hearwhispers" });
});

test("invalid current data falls back to the legacy entry; unavailable storage yields a fresh preview", () => {
  for (const invalid of ["not JSON", "null", '{"products":[null],"review":{},"drafts":{}}', '{"products":[],"review":[],"drafts":{}}']) {
    const result = loadPreviewState(storage({ [storageKey]: invalid, [legacyKey]: JSON.stringify(legacyState) }));
    assert.equal(result.drafts["first-users"], legacyState.drafts["first-users"]);
  }
  assert.deepEqual(loadPreviewState({ getItem() { throw new Error("Storage blocked"); } }), { products: [exampleProduct], review: {}, drafts: {} });
  assert.deepEqual(loadPreviewState(null), { products: [exampleProduct], review: {}, drafts: {} });
});
