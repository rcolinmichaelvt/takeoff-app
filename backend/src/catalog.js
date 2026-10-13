import fs from 'node:fs';

export function loadCatalog(file = new URL('../catalog.json', import.meta.url)) {
  const products = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(products) || products.length > 1000) throw new Error('Invalid product catalog.');
  const seen = new Set();
  for (const item of products) {
    const key = `${item.retailer}:${item.upc}`;
    if (item.retailer !== 'dg' || !/^\d{8,14}$/.test(item.upc || '') ||
      typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120 || seen.has(key)) {
      throw new Error('Invalid or duplicated catalog item.');
    }
    seen.add(key);
  }
  return products.map(({ retailer, upc, title }) => ({ retailer, upc, title }));
}
