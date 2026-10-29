"use strict";
// Pure mapping from the store state the purchase path already fulfils from into the
// protobuf shapes the New Eden Store window reads. No IO, no store access: the caller
// hands in the catalog, so a test can check the mapping without a database.

const CATALOG_NES = 1;
const PLEX_CENTS_PER_PLEX = 100;

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function categoryIdentifier(id) {
  return { sequential: toPositiveInteger(id, 0), catalog: CATALOG_NES };
}

function productIdentifier(id) {
  return { sequential: toPositiveInteger(id, 0), catalog: CATALOG_NES };
}

function offerIdentifier(offer) {
  return { store_offer: String((offer && offer.storeOfferID) || "") };
}

function priceOf(pricing) {
  const currency = String((pricing && pricing.currency) || "PLX");
  const amount = Number(pricing && pricing.price);
  return {
    currency,
    amount_in_cents: Number.isFinite(amount)
      ? Math.round(amount * PLEX_CENTS_PER_PLEX)
      : 0,
  };
}

function buildOfferAttributes(offer) {
  const pricing = (Array.isArray(offer.offerPricings) ? offer.offerPricings : [])[0] || {};
  return {
    name: String(offer.name || ""),
    tags: Array.isArray(offer.tags) ? offer.tags.map(String) : [],
    single_purchase: offer.singlePurchase === true,
    // Nothing in this store is targeted at one character in particular.
    targeted: false,
    no_enddate: true,
    can_purchase: offer.canPurchase !== false,
    no_schedule: true,
    offer_price: priceOf(pricing),
    base_price: priceOf({
      price: pricing.basePrice ?? pricing.price,
      currency: pricing.currency,
    }),
    categories: (Array.isArray(offer.categories) ? offer.categories : [])
      .map((category) => categoryIdentifier(category && category.id)),
    products: (Array.isArray(offer.products) ? offer.products : []).map((product) => ({
      product: productIdentifier(product && product.id),
      quantity: Math.max(1, toPositiveInteger(product && product.quantity, 1)),
    })),
  };
}

function buildCategoryAttributes(category, catalog) {
  const categories = Array.isArray(catalog && catalog.categories) ? catalog.categories : [];
  const children = categories.filter((candidate) => candidate && candidate.parent &&
    toPositiveInteger(candidate.parent.id, 0) === toPositiveInteger(category.id, 0));
  const attributes = {
    name: String(category.name || ""),
    no_parent: !category.parent,
    no_subcategories: children.length === 0,
  };
  if (category.parent) {
    attributes.parent = categoryIdentifier(category.parent.id);
  }
  if (children.length) {
    attributes.subcategories = {
      identifier: children.map((child) => categoryIdentifier(child.id)),
    };
  }
  return attributes;
}

function buildProductAttributes(product, catalog) {
  const offers = Array.isArray(catalog && catalog.offers) ? catalog.offers : [];
  let typeID = 0;
  for (const offer of offers) {
    for (const entry of Array.isArray(offer && offer.products) ? offer.products : []) {
      if (toPositiveInteger(entry && entry.id, 0) === toPositiveInteger(product.id, 0)) {
        typeID = toPositiveInteger(entry && entry.typeId, 0) || typeID;
      }
    }
  }
  const attributes = {
    name: String(product.name || ""),
    character_transfer: false,
  };
  // A product that really is an inventory item says so; an account service such as
  // Omega or MCT has no item type and must not pretend to be one.
  if (typeID > 0) {
    attributes.item = { type: { sequential: typeID }, soulbound: false };
  }
  return attributes;
}

module.exports = {
  CATALOG_NES,
  PLEX_CENTS_PER_PLEX,
  buildCategoryAttributes,
  buildOfferAttributes,
  buildProductAttributes,
  categoryIdentifier,
  offerIdentifier,
  priceOf,
  productIdentifier,
  toPositiveInteger,
};
