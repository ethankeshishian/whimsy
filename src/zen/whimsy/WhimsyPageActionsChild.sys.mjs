/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6: Page actions. Reads the page's own structured data (schema.org
// JSON-LD and microdata) once it has loaded and tells the parent about the
// one thing it describes, if any: an event, a place, a recipe, a product or a
// parcel. No network, no model. Everything sent is plain, size-capped text;
// the parent validates it again before using it.

const FEATURE_PREF = "whimsy.feature.page-actions";
const MAX_SCRIPTS = 20;
const MAX_SCRIPT_LENGTH = 300000;
const MAX_NODES = 2000;
const MAX_TEXT = 500;
const MAX_LIST = 60;

// Lower case: sites write "Recipe", "recipe" and "schema:Recipe" alike.
const PLACE_TYPES = new Set(
  [
  "Place",
  "LocalBusiness",
  "Restaurant",
  "FoodEstablishment",
  "CafeOrCoffeeShop",
  "BarOrPub",
  "Bakery",
  "Store",
  "Museum",
  "Hotel",
  "LodgingBusiness",
  "TouristAttraction",
  "Park",
  "MovieTheater",
  "ShoppingCenter",
  "Library",
  "Pharmacy",
  "Dentist",
  "Physician",
  "HealthClub",
  "BeautySalon",
  "AutoRepair",
  ].map(t => t.toLowerCase())
);

// A node's schema.org types, bare and lower case: "@type" may be a string or
// an array (Allrecipes writes ["Recipe"]), a full URL or a "schema:" name.
function typesOf(node) {
  const raw = node?.["@type"] ?? node?.type;
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter(t => typeof t == "string")
    .map(t =>
      t
        .trim()
        .replace(/^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/i, "")
        .toLowerCase()
    );
}

function kindOf(node) {
  const types = typesOf(node);
  if (types.includes("parceldelivery")) {
    return "parcel";
  }
  if (types.some(t => t == "event" || (t.endsWith("event") && t != "publicationevent"))) {
    return "event";
  }
  if (types.includes("recipe")) {
    return "recipe";
  }
  if (types.includes("product") || types.includes("productgroup")) {
    return "product";
  }
  if (types.some(t => PLACE_TYPES.has(t))) {
    return "place";
  }
  return null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Character references left in JSON-LD strings (Allrecipes writes its
// quotes as &#34;): the summary is plain text, so they become characters.
function decodeEntities(value) {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (match, dec, hex, name) => {
    if (name) {
      return ENTITIES[name.toLowerCase()] ?? match;
    }
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function text(value) {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return text(value[0]);
  }
  if (typeof value == "object") {
    return text(value.name ?? value.text ?? value["@value"] ?? value.url ?? value["@id"]);
  }
  return decodeEntities(String(value).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

function list(value) {
  if (value == null) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).slice(0, MAX_LIST);
}

function address(value) {
  if (!value) {
    return "";
  }
  if (typeof value == "string") {
    return text(value);
  }
  const a = Array.isArray(value) ? value[0] : value;
  return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
    .map(text)
    .filter(Boolean)
    .join(", ");
}

function hours(node) {
  const specs = list(node.openingHoursSpecification).map(s => ({
    days: list(s?.dayOfWeek).map(d => text(d).replace(/^https?:\/\/schema\.org\//, "")),
    opens: text(s?.opens),
    closes: text(s?.closes),
  }));
  const strings = list(node.openingHours).map(text).filter(Boolean);
  return { specs, strings };
}

function steps(value) {
  const out = [];
  const visit = step => {
    if (out.length >= MAX_LIST || step == null) {
      return;
    }
    if (typeof step == "string") {
      for (const line of step.split(/\n+/)) {
        const t = text(line);
        if (t) {
          out.push(t);
        }
      }
      return;
    }
    if (Array.isArray(step)) {
      step.forEach(visit);
      return;
    }
    if (typesOf(step).includes("howtosection")) {
      visit(step.itemListElement);
      return;
    }
    const t = text(step.text ?? step.name);
    if (t) {
      out.push(t);
    }
  };
  visit(value);
  return out;
}

function offer(node) {
  // A ProductGroup's price is on its variants.
  for (const o of [...list(node.offers), ...list(node.hasVariant).flatMap(v => list(v?.offers))]) {
    const price = o?.price ?? o?.lowPrice ?? o?.priceSpecification?.price;
    if (price != null && price !== "") {
      return { price: text(price), currency: text(o.priceCurrency ?? o?.priceSpecification?.priceCurrency) };
    }
  }
  return null;
}

// The plain summary the parent gets for one schema.org item.
export function summarize(kind, node) {
  const base = { kind, name: text(node.name ?? node.headline) };
  switch (kind) {
    case "event": {
      const location = Array.isArray(node.location) ? node.location[0] : node.location;
      return {
        ...base,
        startDate: text(node.startDate),
        endDate: text(node.endDate),
        location: [text(location?.name ?? (typeof location == "string" ? location : "")), address(location?.address)]
          .filter(Boolean)
          .join(", "),
        description: text(node.description),
      };
    }
    case "place":
      return {
        ...base,
        address: address(node.address),
        latitude: Number(node.geo?.latitude) || null,
        longitude: Number(node.geo?.longitude) || null,
        hours: hours(node),
      };
    case "recipe":
      return {
        ...base,
        ingredients: list(node.recipeIngredient ?? node.ingredients).map(text).filter(Boolean),
        steps: steps(node.recipeInstructions),
        yield: text(node.recipeYield),
        totalTime: text(node.totalTime),
      };
    case "product":
      return { ...base, offer: offer(node) };
    case "parcel":
      return {
        ...base,
        name: text(node.itemShipped?.name ?? node.name),
        trackingUrl: text(node.trackingUrl),
        carrier: text(node.provider ?? node.carrier),
      };
  }
  return null;
}

// Every object in a JSON-LD value, following @graph, arrays and nesting, as
// { node, listed }: listed nodes sit in a list (a carousel of related
// recipes, an events listing), so they aren't what the page is about.
function flatten(value, out, depth = 0, listed = false) {
  if (!value || typeof value != "object" || depth > 6 || out.length >= MAX_NODES) {
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      flatten(v, out, depth + 1, listed);
    }
    return;
  }
  out.push({ node: value, listed });
  for (const key of ["@graph", "mainEntity", "itemListElement", "item", "subEvent"]) {
    if (value[key]) {
      flatten(value[key], out, depth + 1, listed || key == "itemListElement" || key == "item");
    }
  }
}

// JSON-LD as sites really write it: wrapped in <!-- --> or CDATA, with
// trailing commas, or with raw line breaks inside strings. Strict first.
export function parseJsonLd(source) {
  try {
    return JSON.parse(source);
  } catch {}
  let loose = source
    .trim()
    .replace(/^(?:<!--|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)/, "")
    .replace(/(?:-->|\/\/\s*\]\]>|\]\]>)$/, "")
    .trim();
  // Control characters inside strings become spaces; outside them they're
  // whitespace anyway. Then drop commas before a closing bracket.
  let out = "";
  let inString = false;
  for (let i = 0; i < loose.length; i++) {
    const c = loose[i];
    if (inString) {
      if (c == "\\") {
        out += c + (loose[i + 1] ?? "");
        i++;
        continue;
      }
      if (c == '"') {
        inString = false;
      }
      out += c < " " ? " " : c;
      continue;
    }
    if (c == '"') {
      inString = true;
    } else if (c == "," && /^\s*[}\]]/.test(loose.slice(i + 1, i + 200))) {
      continue;
    }
    out += c;
  }
  loose = out;
  try {
    return JSON.parse(loose);
  } catch {
    return null;
  }
}

// The address of a page without its fragment, query or trailing slash, to
// tell the item a page is about from items it links to.
function pageKey(spec) {
  try {
    const url = new URL(spec);
    return (url.host + url.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return null;
  }
}

function selfKeys(node) {
  return [node.url, node["@id"], node.mainEntityOfPage, node.mainEntityOfPage?.["@id"], node.mainEntityOfPage?.url]
    .filter(v => typeof v == "string")
    .map(pageKey)
    .filter(Boolean);
}

// Of several items of one kind, the one the page is about: the only one with
// one name; else the only one not in a list; else the one whose url is this
// page; else a product family (a ProductGroup and its variants). null when
// it stays ambiguous (a listing, a shop's category page).
function pick(found, docSpec) {
  const nameOf = entry => text(entry.node.name ?? entry.node.headline).toLowerCase();
  const single = entries => (entries.length && new Set(entries.map(nameOf)).size == 1 ? entries : null);
  const here = pageKey(docSpec);
  const candidates =
    single(found) ||
    single(found.filter(e => !e.listed)) ||
    single(found.filter(e => here && selfKeys(e.node).includes(here))) ||
    single(found.filter(e => !e.listed && typesOf(e.node).includes("productgroup")));
  if (!candidates) {
    return null;
  }
  // The same item described twice (JSON-LD and microdata): the fuller one.
  return candidates.find(e => !e.listed)?.node ?? candidates[0].node;
}

// A microdata item as a JSON-LD-like object (one level of nesting).
function microdata(element, depth = 0) {
  const node = { "@type": (element.getAttribute("itemtype") || "").split(/\s+/).map(t => t.split("/").pop()) };
  const walk = parent => {
    for (const child of parent.children) {
      const prop = child.getAttribute("itemprop");
      if (prop) {
        let value;
        if (child.hasAttribute("itemscope")) {
          value = depth < 3 ? microdata(child, depth + 1) : null;
        } else {
          value =
            child.getAttribute("content") ??
            child.getAttribute("datetime") ??
            (["A", "LINK"].includes(child.tagName) ? child.href : null) ??
            child.textContent;
        }
        for (const name of prop.split(/\s+/)) {
          if (node[name] === undefined) {
            node[name] = value;
          } else {
            node[name] = [].concat(node[name], value);
          }
        }
      }
      if (!child.hasAttribute("itemscope")) {
        walk(child);
      }
    }
  };
  walk(element);
  return node;
}

// The page's one item worth an action, or null (none, or several of the same
// kind, like an events listing or a shop's category page).
export function findAction(doc) {
  const nodes = [];
  // type="application/ld+json", in any case and with or without parameters.
  const scripts = [...doc.querySelectorAll("script[type]")].filter(s =>
    /^\s*application\/ld\+json\s*(?:;|$)/i.test(s.getAttribute("type"))
  );
  for (const script of scripts.slice(0, MAX_SCRIPTS)) {
    const source = script.textContent;
    if (!source || source.length > MAX_SCRIPT_LENGTH) {
      continue;
    }
    flatten(parseJsonLd(source), nodes);
  }
  for (const item of [...doc.querySelectorAll("[itemscope][itemtype]:not([itemprop])")].slice(0, MAX_LIST)) {
    nodes.push({ node: microdata(item), listed: false });
  }
  const byKind = new Map();
  for (const entry of nodes) {
    const kind = kindOf(entry.node);
    if (kind) {
      if (!byKind.has(kind)) {
        byKind.set(kind, []);
      }
      byKind.get(kind).push(entry);
    }
  }
  for (const kind of ["parcel", "event", "recipe", "product", "place"]) {
    const found = byKind.get(kind);
    const node = found && pick(found, doc.documentURI);
    if (!node) {
      continue;
    }
    const summary = summarize(kind, node);
    if (summary?.name || kind == "parcel") {
      return summary;
    }
  }
  return null;
}

export class WhimsyPageActionsChild extends JSWindowActorChild {
  // DOMContentLoaded: the data is in the page's HTML, so the pill needn't
  // wait for every ad and image to load (on an ad-heavy page like Allrecipes
  // "load" can take many seconds). pageshow again for data a script added
  // and for pages restored from the back-forward cache.
  handleEvent(event) {
    if (!["DOMContentLoaded", "pageshow"].includes(event.type) || !Services.prefs.getBoolPref(FEATURE_PREF, true)) {
      return;
    }
    const doc = this.document;
    if (!doc || event.target != doc) {
      return;
    }
    let action = null;
    try {
      action = findAction(doc);
    } catch (e) {
      console.error("Whimsy: page actions", e);
    }
    // Nothing to say for most pages; the parent forgets a page's action when
    // the tab navigates.
    if (action) {
      this.sendAsyncMessage("WhimsyPageActions:Found", { spec: doc.documentURI, action });
    }
  }
}
