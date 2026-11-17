/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const pendingOrders = new WeakMap();

const FEATURE = "whimsy.feature.command-bar-ranking";

export function foldCommandName(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export function commandMatchTier(name, query) {
  const label = foldCommandName(name);
  const text = foldCommandName(query);
  if (label == text) {
    return 0;
  }
  if (label.startsWith(text)) {
    return 1;
  }
  return [...label.matchAll(/[^\p{L}\p{N}]+/gu)].some(match =>
    label.slice(match.index + match[0].length).startsWith(text)) ? 2 : 3;
}

function commandInfo(result) {
  const p = result.payload;
  // zenAction alone also marks Ask/Do rows. Only these two providers' action
  // types are commands; update, bang, emoji, history, and tab rows stay native.
  if (p?.dynamicType == "zen-actions" && !p.workspaceId) {
    const extension = !!p.extensionId;
    return {
      name: extension ? p.prettyName : p.title,
      kind: extension ? 2 : result.commandId?.startsWith("cmd_whimsySetting-") ? 1 : 0,
      id: result.commandId ?? p.zenCommand ?? "",
    };
  }
  if (p?.dynamicType == "whimsy-verb") {
    return { name: p.title, kind: 3, id: p.whimsyVerb };
  }
  return null;
}

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** One ranking pass, before the native muxer applies its result limit.
 * Learned heuristic/index hints on commands must not override this order.
 * Native non-command rows retain their relative order and placement hints.
 */
export function rankCommandResults(context, results) {
  pendingOrders.delete(context);
  const query = context.searchString?.trim();
  const source = context.searchMode?.source;
  if (!Services.prefs.getBoolPref(FEATURE, true) || !query ||
      /^[:!]/.test(query) ||
      (context.searchMode && source != UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS)) {
    return results;
  }
  const commands = [];
  const others = [];
  for (const result of results) {
    const info = commandInfo(result);
    if (info) {
      commands.push({ result, ...info, tier: commandMatchTier(info.name, query) });
    } else {
      others.push(result);
    }
  }
  if (!commands.length) {
    return results;
  }
  commands.sort((a, b) => a.tier - b.tier || a.kind - b.kind ||
    compareText(foldCommandName(a.name), foldCommandName(b.name)) ||
    compareText(String(a.id), String(b.id)) || compareText(a.name, b.name));
  // Preserve the normal provider's five-action budget, after ranking rather
  // than before it. Actions mode can use the whole native result budget.
  const selected = source == UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS ? commands : commands.slice(0, 5);
  const exact = selected[0].tier == 0;
  for (const [i, { result }] of selected.entries()) {
    result.heuristic = exact && i == 0;
    result.suggestedIndex = result.heuristic ? undefined : i + (exact ? 0 : 1);
  }
  pendingOrders.set(context, { selected: selected.map(({ result }) => result), exact });
  // Feed the exact command first, independent of provider arrival. Zen
  // gives its action heuristic a group ahead of navigation heuristics.
  return [...selected.map(({ result }) => result), ...others];
}


/** Resolve native suggested-index collisions without ranking a second time. */
export function placeCommandResults(context, results) {
  const order = pendingOrders.get(context);
  pendingOrders.delete(context);
  if (!order) {
    return results;
  }
  const visible = new Set(results);
  const commands = order.selected.filter(result => visible.has(result));
  const commandSet = new Set(commands);
  let index = 0;
  const placed = results.map(result => commandSet.has(result) ? commands[index++] : result);
  // Other providers can insert at zero too. Their hints must not put history
  // or tabs ahead of the exact command, or invert two commands' final order.
  if (order.exact && visible.has(order.selected[0])) {
    const exact = order.selected[0];
    placed.splice(placed.indexOf(exact), 1);
    placed.unshift(exact);
    context.heuristicResult = exact;
  }
  return placed;
}
