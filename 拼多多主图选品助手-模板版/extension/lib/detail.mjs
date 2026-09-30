export const DETAIL_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  PARTIAL: 'partial',
  ERROR: 'error'
});

const statuses = new Set(Object.values(DETAIL_STATUS));
const text = value => value == null ? '' : String(value).trim();

function httpsUrl(value) {
  const candidate = text(value);
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? candidate : '';
  } catch {
    return '';
  }
}

function urlList(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(httpsUrl).filter(Boolean))];
}

function positiveCents(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function explicitCents(value) {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
  return positiveCents(value);
}

function priceCents(value) {
  const price = text(value);
  if (!/^\d+(?:\.\d+)?$/.test(price)) return 0;
  const cents = Math.round(Number(price) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
}

export function fallbackSku(product = {}) {
  return {
    id: '',
    specs: [],
    cents: positiveCents(product?.cents),
    image: httpsUrl(product?.image),
    stock: '',
    weightKg: '',
    sizeCm: ''
  };
}

function cleanStrings(values, limit = Infinity) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(text).filter(Boolean))].slice(0, limit);
}

function normalizedSku(sku) {
  if (!sku || typeof sku !== 'object') return null;
  const cents = explicitCents(sku.cents) || priceCents(sku.price);
  if (!cents) return null;
  const id = text(sku.id) || text(sku.skuId);
  return {
    id,
    specs: Array.isArray(sku.specs) ? sku.specs.map(text).filter(Boolean).slice(0, 2) : [],
    cents,
    image: httpsUrl(sku.image),
    stock: text(sku.stock),
    weightKg: text(sku.weightKg),
    sizeCm: text(sku.sizeCm)
  };
}

export function normalizeDetail(raw = {}, fallback = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  fallback = fallback && typeof fallback === 'object' ? fallback : {};

  const galleryImages = urlList(raw.galleryImages);
  if (!galleryImages.length) {
    const fallbackImage = httpsUrl(fallback.image);
    if (fallbackImage) galleryImages.push(fallbackImage);
  }

  const attributes = [];
  const attributeKeys = new Set();
  if (Array.isArray(raw.attributes)) {
    for (const attribute of raw.attributes) {
      if (!attribute || typeof attribute !== 'object') continue;
      const name = text(attribute.name) || text(attribute.key);
      const value = text(attribute.value);
      if (!name || !value) continue;
      const key = `${name}\u001f${value}`;
      if (attributeKeys.has(key)) continue;
      attributeKeys.add(key);
      attributes.push({ name, value });
    }
  }

  const detailCents = explicitCents(raw.cents) || priceCents(raw.price);
  const skus = [];
  const skuKeys = new Set();
  if (Array.isArray(raw.skus)) {
    for (const item of raw.skus) {
      const sku = normalizedSku(item);
      if (!sku) continue;
      const key = sku.id || JSON.stringify([sku.specs, sku.cents, sku.image]);
      if (skuKeys.has(key)) continue;
      skuKeys.add(key);
      skus.push(sku);
    }
  }
  const image = galleryImages[0] || httpsUrl(fallback.image);
  if (!skus.length) skus.push(fallbackSku({ ...fallback, image, cents: detailCents || fallback.cents }));

  const rawTitle = text(raw.title);
  const status = text(raw.detailStatus);
  return {
    title: rawTitle || text(fallback.title),
    image,
    galleryImages,
    descriptionText: '',
    detailImages: urlList(raw.detailImages),
    category: text(raw.category),
    attributes,
    videoUrl: httpsUrl(raw.videoUrl),
    certificateImages: urlList(raw.certificateImages),
    sizeChartImages: urlList(raw.sizeChartImages),
    specNames: cleanStrings(raw.specNames, 2),
    skus,
    detailCents,
    detailStatus: statuses.has(status) ? status : DETAIL_STATUS.DONE,
    detailNote: text(raw.detailNote).slice(0, 500)
  };
}
