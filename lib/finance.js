// Per-brand finance config. Only brands listed here get a /finance section.
// Add a new brand slug → array of founder names to enable Finance for it.
const BRAND_FOUNDERS = {
  vaayuraksh: ['Mahalakshmi', 'Pooja']
};

function foundersFor(brandSlug) {
  return BRAND_FOUNDERS[brandSlug] || null;
}

function brandHasFinance(brandSlug) {
  return Array.isArray(BRAND_FOUNDERS[brandSlug]);
}

module.exports = { foundersFor, brandHasFinance, BRAND_FOUNDERS };
