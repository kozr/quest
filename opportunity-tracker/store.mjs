import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, 'tracker.json');
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { version: 1, products: [], items: [], searches: {} };
    if (this.data.version !== 1 || !Array.isArray(this.data.products) || !Array.isArray(this.data.items)) throw new Error('The saved tracker data could not be read. Restore a backup before restarting.');
  }
  commit(next) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.data = next;
  }
  snapshot() { return structuredClone(this.data); }
  saveProduct(product, id) {
    const next = this.snapshot();
    const prior = id ? next.products.find(p => p.id === id) : null;
    if (id && !prior) return null;
    const record = { ...prior, ...product, id: id || randomUUID(), createdAt: prior?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    next.products = [record, ...next.products.filter(p => p.id !== record.id)];
    this.commit(next);
    return record;
  }
  deleteProduct(id) {
    const next = this.snapshot();
    next.products = next.products.filter(p => p.id !== id);
    next.items = next.items.filter(p => p.productId !== id);
    delete next.searches[id];
    this.commit(next);
  }
  recordSearch(productId, result) {
    const next = this.snapshot();
    if (!next.products.some(p => p.id === productId)) return null;
    for (const item of result.items) {
      const id = createHash('sha256').update(`${productId}:${item.url}`).digest('hex').slice(0, 24);
      const previous = next.items.find(i => i.id === id);
      const record = { ...item, id, productId, status: previous?.status || 'new', note: previous?.note || '', foundAt: previous?.foundAt || result.searchedAt, lastSeenAt: result.searchedAt };
      next.items = [record, ...next.items.filter(i => i.id !== id)];
    }
    next.searches[productId] = { ...result, items: undefined, found: result.items.length };
    this.commit(next);
    return next.searches[productId];
  }
  updateItem(id, update) {
    const next = this.snapshot();
    const item = next.items.find(i => i.id === id);
    if (!item) return null;
    Object.assign(item, update);
    this.commit(next);
    return item;
  }
  importData(value) {
    this.commit(structuredClone(value));
  }
}
