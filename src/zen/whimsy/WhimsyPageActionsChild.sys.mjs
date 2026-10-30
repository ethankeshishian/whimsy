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

const PLACE_TYPES = new Set([
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
]);

function typesOf(node) {
  const raw = node?.["@type"] ?? node?.type;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(t => typeof t == "string").map(t => t.replace(/^https?:\/\/schema\.org\//, ""));
}

function kindOf(node) {
  const types = typesOf(node);
  if (types.includes("ParcelDelivery")) {
    return "parcel";
  }
  if (types.some(t => t == "Event" || (t.endsWith("Event") && t != "PublicationEvent"))) {
    return "event";
  }
  if (types.includes("Recipe")) {
    return "recipe";
  }
  if (types.includes("Product") || types.includes("ProductGroup")) {
    return "product";
  }
  if (types.some(t => PLACE_TYPES.has(t))) {
    return "place";
  }
  return null;
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
  return String(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
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
    if (typesOf(step).includes("HowToSection")) {
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
  for (const o of list(node.offers)) {
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

// Every object in a JSON-LD value, following @graph, arrays and nesting.
function flatten(value, out, depth = 0) {
  if (!value || typeof value != "object" || depth > 6 || out.length >= MAX_NODES) {
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      flatten(v, out, depth + 1);
    }
    return;
  }
  out.push(value);
  for (const key of ["@graph", "mainEntity", "itemListElement", "item", "subEvent"]) {
    if (value[key]) {
      flatten(value[key], out, depth + 1);
    }
  }
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
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of [...scripts].slice(0, MAX_SCRIPTS)) {
    const source = script.textContent;
    if (!source || source.length > MAX_SCRIPT_LENGTH) {
      continue;
    }
    try {
      flatten(JSON.parse(source), nodes);
    } catch {}
  }
  for (const item of [...doc.querySelectorAll("[itemscope][itemtype]:not([itemprop])")].slice(0, MAX_LIST)) {
    nodes.push(microdata(item));
  }
  const byKind = new Map();
  for (const node of nodes) {
    const kind = kindOf(node);
    if (kind) {
      if (!byKind.has(kind)) {
        byKind.set(kind, []);
      }
      byKind.get(kind).push(node);
    }
  }
  for (const kind of ["parcel", "event", "recipe", "product", "place"]) {
    const found = byKind.get(kind);
    if (!found) {
      continue;
    }
    // The same item described twice (JSON-LD and microdata) still counts once.
    const names = new Set(found.map(n => text(n.name)));
    if (names.size != 1) {
      continue;
    }
    const summary = summarize(kind, found[0]);
    if (summary?.name || kind == "parcel") {
      return summary;
    }
  }
  return null;
}

export class WhimsyPageActionsChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type != "pageshow" || !Services.prefs.getBoolPref(FEATURE_PREF, true)) {
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
