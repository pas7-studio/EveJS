"use strict";
// Skin market listings (eve_public.cosmetic.market.skin.listing.*).
//
// A listing is a promise to sell real copies of a third-party skin. So creating one moves the
// copies into escrow in the seller's own licence row before the row exists (space/
// coopThirdPartySkins.escrow), and cancelling gives exactly those copies back. A listing whose
// copies are no longer escrowed is dropped on read, so a stale row can never pretend stock it
// does not have.
//
// The rows are world-wide, so they live in their own small table rather than in a character
// record; the seller id inside each row is what makes GetAllOwned honest.
const path = require("path");

// Rows live in the seller's own character record, next to the licences they escrow; the market
// view is the union over characters. A listing therefore cannot exist without its owner.
const KEY = "skinListings";
const VERSION = 1;
const MAX_LISTINGS = 2000;

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function uuidKey(value) {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value == null ? "" : value).trim().toLowerCase();
}

function emptyState() {
  return { version: VERSION, listings: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Number(raw.version) !== VERSION ||
    !raw.listings || typeof raw.listings !== "object" || Array.isArray(raw.listings)) {
    return emptyState();
  }
  const listings = {};
  for (const [key, row] of Object.entries(raw.listings)) {
    const uuid = uuidKey(key);
    if (!uuid || !row || typeof row !== "object") continue;
    listings[uuid] = {
      uuid,
      sellerID: int(row.sellerID),
      skin: String(row.skin || ""),
      quantity: Math.max(0, int(row.quantity)),
      priceUnits: Math.max(0, int(row.priceUnits)),
      priceNanos: int(row.priceNanos),
      createdMs: Math.max(0, int(row.createdMs)),
      expiresMs: Math.max(0, int(row.expiresMs)),
      transaction: uuidKey(row.transaction),
      public: row.public !== false,
    };
  }
  return { version: VERSION, listings };
}

function createSkinListings({
  characterState = null,
  gameStore = null,
  wallet = null,
  taxNanos = 25_000_000,
  skins = null,
  clock = () => Date.now(),
  randomUuid = () => require("crypto").randomBytes(16),
  env = process.env,
} = {}) {
  const owner = () => characterState || require(path.join(
    __dirname,
    "../services/character/characterState",
  ));
  const store = () => gameStore || require(path.join(__dirname, "../gameStore"));
  // The native wallet path: transfer moves ISK between two characters and refuses an overdraft.
  const money = () => wallet || require(path.join(__dirname, "../services/account/walletState"));
  const licences = () => skins || require(path.join(__dirname, "./coopThirdPartySkins")).shared();
  const enabled = () => env.EVEJS_COOP_SKIN_MARKET === "1";

  function stateOf(characterID) {
    try {
      const record = owner().getCharacterRecord(characterID);
      return normalizeState(record && record[KEY]);
    } catch (_error) {
      return emptyState();
    }
  }

  function writeState(characterID, state) {
    const written = owner().updateCharacterRecord(characterID, (record) => ({
      ...(record || {}),
      [KEY]: state,
    }));
    if (!written || written.success !== true) throw Error("SKIN_LISTINGS_WRITE_FAILED");
    return state;
  }

  // Every character that could hold a listing; the market view is the union of their rows.
  function characterIDs() {
    try {
      const read = store().read("characters", "/");
      const data = (read && read.success === true && read.data) || {};
      return Object.keys(data).map((key) => Number(key)).filter((id) => id > 0);
    } catch (_error) {
      return [];
    }
  }

  // A listing survives only while it is not expired and its copies are really in escrow.
  // Expired rows are dropped on read, and their copies go back to the seller, so a listing can
  // never outlive its time or hold stock it no longer has.
  function liveListings(nowMs) {
    const now = Number(nowMs) || int(clock());
    const live = [];
    for (const characterID of characterIDs()) {
      const state = stateOf(characterID);
      let changed = false;
      for (const [key, row] of Object.entries(state.listings)) {
        if (row.expiresMs > 0 && row.expiresMs <= now) {
          const released = licences().releaseEscrow(row.sellerID, row.skin, row.quantity);
          if (released.status === "RELEASED" || released.status === "LICENCE_NOT_FOUND") {
            delete state.listings[key];
            changed = true;
            continue;
          }
        }
        live.push(row);
      }
      if (changed) {
        try {
          writeState(characterID, state);
        } catch (_error) {
          // the read still reports what is really there
        }
      }
    }
    return live;
  }

  function all(nowMs) {
    if (!enabled()) return [];
    return liveListings(nowMs).filter((row) => row.public)
      .sort((left, right) => (left.createdMs - right.createdMs) || left.uuid.localeCompare(right.uuid));
  }

  function owned(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return [];
    return liveListings().filter((row) => row.sellerID === id)
      .sort((left, right) => (right.createdMs - left.createdMs) || left.uuid.localeCompare(right.uuid));
  }

  function get(uuid) {
    const key = uuidKey(uuid);
    if (!enabled() || !key) return null;
    return liveListings().find((row) => row.uuid === key) || null;
  }

  function create(sellerID, {
    skin, quantity = 1, priceUnits = 0, priceNanos = 0, durationMs = 0,
  } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(sellerID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const hex = String(skin || "").trim().toLowerCase();
    if (!hex) return { status: "SKIN_REQUIRED" };
    const count = int(quantity);
    if (count <= 0) return { status: "QUANTITY_REQUIRED" };
    const units = int(priceUnits);
    if (units <= 0) return { status: "PRICE_REQUIRED" };
    if (all().length >= MAX_LISTINGS) return { status: "TOO_MANY_LISTINGS" };
    const state = stateOf(id);

    const escrowed = licences().escrow(id, hex, count);
    if (escrowed.status !== "ESCROWED") {
      return escrowed.status === "NOT_ENOUGH_COPIES"
        ? { status: "NOT_ENOUGH_COPIES", available: escrowed.available }
        : escrowed;
    }

    const nowMs = int(clock());
    let uuid = "";
    for (let attempt = 0; attempt < 8 && !uuid; attempt += 1) {
      const candidate = uuidKey(randomUuid());
      if (candidate && !state.listings[candidate]) uuid = candidate;
    }
    if (!uuid) {
      licences().releaseEscrow(id, hex, count);
      return { status: "UUID_FAILED" };
    }
    const row = {
      uuid,
      sellerID: id,
      skin: hex,
      quantity: count,
      priceUnits: units,
      priceNanos: int(priceNanos),
      createdMs: nowMs,
      expiresMs: durationMs > 0 ? nowMs + int(durationMs) : 0,
      transaction: uuidKey(randomUuid()),
      public: true,
    };
    state.listings[uuid] = row;
    try {
      writeState(id, state);
    } catch (_error) {
      licences().releaseEscrow(id, hex, count);
      return { status: "WRITE_FAILED" };
    }
    return { status: "CREATED", listing: row, transaction: row.transaction };
  }

  // Only the seller can cancel, and the copies go back to them exactly once.
  function cancel(sellerID, uuid) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(sellerID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const key = uuidKey(uuid);
    if (!key) return { status: "UUID_REQUIRED" };
    const row = get(key);
    if (!row) return { status: "NOT_FOUND" };
    if (row.sellerID !== id) return { status: "NOT_YOURS" };
    const state = stateOf(id);
    delete state.listings[key];
    try {
      writeState(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    const released = licences().releaseEscrow(id, row.skin, row.quantity);
    if (released.status !== "RELEASED" && released.status !== "LICENCE_NOT_FOUND") {
      return { status: "RELEASE_FAILED", reason: released.status };
    }
    return { status: "CANCELLED", listing: row };
  }

  // Admin expiry: a date in the past is refused rather than silently making a dead listing.
  function setExpiration(actorID, uuid, expiresMs) {
    if (!enabled()) return { status: "DISABLED" };
    const key = uuidKey(uuid);
    if (!key) return { status: "UUID_REQUIRED" };
    const when = int(expiresMs);
    if (when <= 0) return { status: "EXPIRY_REQUIRED" };
    if (when <= int(clock())) return { status: "EXPIRY_IN_PAST" };
    const row = get(key);
    if (!row) return { status: "NOT_FOUND" };
    const state = stateOf(row.sellerID);
    if (!state.listings[key]) return { status: "NOT_FOUND" };
    state.listings[key].expiresMs = when;
    const target = state.listings[key];
    try {
      writeState(row.sellerID, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "EXPIRY_SET", listing: target };
  }

  // Buying pays for real: the buyer's gross price moves to the seller through the native wallet
  // transfer, the seller pays the sales tax out of the proceeds, and only then do the escrowed
  // copies change hands. Any failure after the transfer puts the ISK back, so a purchase either
  // happens completely or leaves no trace on a wallet.
  function purchase(buyerID, uuid, quantity = 1) {
    if (!enabled()) return { status: "DISABLED" };
    const buyer = int(buyerID);
    if (buyer <= 0) return { status: "NO_CHARACTER" };
    const key = uuidKey(uuid);
    if (!key) return { status: "UUID_REQUIRED" };
    const wanted = int(quantity);
    if (wanted <= 0) return { status: "QUANTITY_REQUIRED" };
    const row = get(key);
    if (!row) return { status: "NOT_FOUND" };
    if (row.sellerID === buyer) return { status: "OWN_LISTING" };
    if (wanted > row.quantity) return { status: "NOT_ENOUGH_STOCK", available: row.quantity };

    const unitPrice = Math.max(1, row.priceUnits) + (row.priceNanos > 0 ? 0 : 0);
    const gross = unitPrice * wanted;
    const tax = Math.round(gross * (taxNanos / 1e9));
    const net = gross - tax;

    const paid = money().transferCharacterBalance(buyer, row.sellerID, gross, {
      reason: `SKIN market purchase ${row.skin}`,
    });
    if (!paid || paid.success !== true) {
      return { status: paid && paid.errorMsg === "INSUFFICIENT_FUNDS"
        ? "NOT_ENOUGH_ISK" : "PAYMENT_FAILED" };
    }
    if (tax > 0) {
      const taxed = money().adjustCharacterBalance(row.sellerID, -tax, {
        reason: `SKIN market sales tax ${row.skin}`,
      });
      if (!taxed || taxed.success !== true) {
        money().transferCharacterBalance(row.sellerID, buyer, gross, {
          reason: "SKIN market purchase rolled back",
        });
        return { status: "TAX_FAILED" };
      }
    }

    // The copies leave the seller's escrow and land with the buyer, keeping the design's identity.
    const spent = licences().consumeEscrow(row.sellerID, row.skin, wanted);
    if (spent.status !== "CONSUMED") {
      money().transferCharacterBalance(row.sellerID, buyer, gross, {
        reason: "SKIN market purchase rolled back",
      });
      if (tax > 0) money().adjustCharacterBalance(row.sellerID, tax, { reason: "tax refund" });
      return { status: "ESCROW_FAILED", reason: spent.status };
    }
    const sellerRow = licences().get(row.sellerID, row.skin) || {};
    const delivered = licences().grant(buyer, {
      skin: row.skin,
      unactivated: wanted,
      name: sellerRow.name || "",
      lineName: sellerRow.lineName || "",
      layout: sellerRow.layout || "",
      creatorID: sellerRow.creatorID || 0,
    });
    if (delivered.status !== "GRANTED") {
      licences().releaseEscrow(row.sellerID, row.skin, wanted);
      money().transferCharacterBalance(row.sellerID, buyer, gross, {
        reason: "SKIN market purchase rolled back",
      });
      if (tax > 0) money().adjustCharacterBalance(row.sellerID, tax, { reason: "tax refund" });
      return { status: "DELIVERY_FAILED" };
    }

    const state = stateOf(row.sellerID);
    const liveRow = state.listings[key];
    if (liveRow) {
      if (wanted >= liveRow.quantity) {
        delete state.listings[key];
      } else {
        liveRow.quantity -= wanted;
      }
      try {
        writeState(row.sellerID, state);
      } catch (_error) {
        // the copies and the money already moved; the row is pruned on the next read
      }
    }
    const transaction = uuidKey(randomUuid());
    return { status: "PURCHASED", transaction, gross, tax, net, quantity: wanted, skin: row.skin };
  }

  return Object.freeze({
    enabled,
    purchase,
    all,
    owned,
    get,
    create,
    cancel,
    setExpiration,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createSkinListings();
  }
  return singleton;
}

module.exports = {
  KEY,
  MAX_LISTINGS,
  STATE_KEY: KEY,
  createSkinListings,
  emptyState,
  normalizeState,
  shared,
  uuidKey,
};
