/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 safety-check: WhimsySafetyCheck.sys.mjs itself (design/safety-check).
// Four checks, each independently ok/warn, plus the unused-permissions
// helper the Settings sheet uses (checked on this device only; nothing is
// sent anywhere).

const { WhimsySafetyCheck } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsySafetyCheck.sys.mjs");

function principalFor(origin) {
  return Services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
}

registerCleanupFunction(() => {
  WhimsySafetyCheck._readUpdates = null;
  WhimsySafetyCheck._getLogins = null;
  WhimsySafetyCheck._getBreaches = null;
  WhimsySafetyCheck._getAddons = null;
  WhimsySafetyCheck._lastVisit = null;
  for (const perm of Services.perms.all) {
    if (WhimsySafetyCheck.PERMISSION_TYPES.includes(perm.type) && perm.principal.origin.includes("example.")) {
      Services.perms.removeFromPrincipal(perm.principal, perm.type);
    }
  }
});

add_task(async function updates_ok_and_warn() {
  WhimsySafetyCheck._readUpdates = async () => [null, { version: "1.24b-w3.7" }];
  is((await WhimsySafetyCheck.checkUpdates()).status, "ok", "No staged update: ok");
  is((await WhimsySafetyCheck.checkUpdates()).version, "1.24b-w3.7", "and reports the running version");

  const installedAt = Date.now() - 86_400_000;
  WhimsySafetyCheck._readUpdates = async () => [
    { installed: { installed_at: installedAt } },
    { version: "1.24b-w3.7" },
  ];
  const ok = await WhimsySafetyCheck.checkUpdates();
  is(ok.status, "ok", "An installed (not staged) update is still ok");
  is(ok.installedAt, installedAt, "and carries when it installed");

  WhimsySafetyCheck._readUpdates = async () => [{ staged: { version: "1.24b-w3.8" } }, { version: "1.24b-w3.7" }];
  const warn = await WhimsySafetyCheck.checkUpdates();
  is(warn.status, "warn", "A staged update: warn");
  is(warn.version, "1.24b-w3.8", "the staged (not running) version");
});

add_task(async function passwords_ok_and_warn() {
  WhimsySafetyCheck._getLogins = async () => [];
  is((await WhimsySafetyCheck.checkPasswords()).status, "ok", "No saved passwords: ok");
  is((await WhimsySafetyCheck.checkPasswords()).count, 0, "with a count of zero");

  const safe = { guid: "safe-1", origin: "https://safe.example" };
  const breached1 = { guid: "breached-1", origin: "https://breached.example" };
  const breached2 = { guid: "breached-2", origin: "https://breached.example" };
  WhimsySafetyCheck._getLogins = async () => [safe];
  WhimsySafetyCheck._getBreaches = async () => new Map();
  const ok = await WhimsySafetyCheck.checkPasswords();
  is(ok.status, "ok", "No breached logins: ok");
  is(ok.count, 1, "counting every saved login");

  WhimsySafetyCheck._getLogins = async () => [safe, breached1, breached2];
  WhimsySafetyCheck._getBreaches = async () => new Map([
    ["breached-1", { Domain: "breached.example" }],
    ["breached-2", { Domain: "breached.example" }],
  ]);
  const warn = await WhimsySafetyCheck.checkPasswords();
  is(warn.status, "warn", "Any breached login: warn");
  is(warn.count, 2, "counting only the breached ones");
  is(warn.sites.length, 1, "de-duplicated by origin");
  is(warn.sites[0], "https://breached.example", "naming the site");
});

add_task(async function extensions_ok_and_warn() {
  const STATE_NOT_BLOCKED = Ci.nsIBlocklistService.STATE_NOT_BLOCKED;
  const amo = { id: "amo@ext", name: "From AMO", hidden: false, blocklistState: STATE_NOT_BLOCKED,
    userPermissions: { origins: ["<all_urls>"] }, sourceURI: Services.io.newURI("https://addons.mozilla.org/firefox/downloads/file/1/x.xpi") };
  const scoped = { id: "scoped@ext", name: "Scoped", hidden: false, blocklistState: STATE_NOT_BLOCKED,
    userPermissions: { origins: ["https://example.com/*"] }, sourceURI: null };
  const sideloadedReadsAll = { id: "sideload@ext", name: "Reads Everything", hidden: false, blocklistState: STATE_NOT_BLOCKED,
    userPermissions: { origins: ["<all_urls>"] }, sourceURI: null };
  const blocklisted = { id: "bad@ext", name: "Blocklisted", hidden: false, blocklistState: Ci.nsIBlocklistService.STATE_BLOCKED,
    userPermissions: { origins: [] }, sourceURI: null };
  const hiddenAllUrls = { id: "hidden@ext", name: "Hidden", hidden: true, blocklistState: STATE_NOT_BLOCKED,
    userPermissions: { origins: ["<all_urls>"] }, sourceURI: null };

  WhimsySafetyCheck._getAddons = async () => [amo, scoped];
  const ok = await WhimsySafetyCheck.checkExtensions();
  is(ok.status, "ok", "An AMO all-sites extension and a scoped one: ok");
  is(ok.count, 2, "counting both visible extensions");

  WhimsySafetyCheck._getAddons = async () => [amo, sideloadedReadsAll];
  const warnReadsAll = await WhimsySafetyCheck.checkExtensions();
  is(warnReadsAll.status, "warn", "A non-AMO all-sites extension: warn");
  is(warnReadsAll.first.id, "sideload@ext", "naming it");

  WhimsySafetyCheck._getAddons = async () => [amo, blocklisted];
  const warnBlocklisted = await WhimsySafetyCheck.checkExtensions();
  is(warnBlocklisted.status, "warn", "A blocklisted extension: warn, even without all-sites access");
  is(warnBlocklisted.first.id, "bad@ext", "naming it");

  WhimsySafetyCheck._getAddons = async () => [amo, hiddenAllUrls];
  const ignoresHidden = await WhimsySafetyCheck.checkExtensions();
  is(ignoresHidden.status, "ok", "A hidden (built-in) extension is never flagged");
  is(ignoresHidden.count, 1, "and isn't counted either");
});

add_task(async function permissions_unused_detected_and_removed() {
  const staleOrigin = "https://stale.example.com";
  const freshOrigin = "https://fresh.example.com";
  const stalePrincipal = principalFor(staleOrigin);
  const freshPrincipal = principalFor(freshOrigin);
  Services.perms.addFromPrincipal(stalePrincipal, "camera", Services.perms.ALLOW_ACTION);
  Services.perms.addFromPrincipal(stalePrincipal, "geo", Services.perms.ALLOW_ACTION);
  Services.perms.addFromPrincipal(freshPrincipal, "microphone", Services.perms.ALLOW_ACTION);
  // A denied grant on the stale site shouldn't count as "still has access".
  Services.perms.addFromPrincipal(stalePrincipal, "desktop-notification", Services.perms.DENY_ACTION);

  const ninetyOneDaysAgo = Date.now() - 91 * 86_400_000;
  const tenDaysAgo = Date.now() - 10 * 86_400_000;
  WhimsySafetyCheck._lastVisit = host => {
    if (host == "stale.example.com") {
      return ninetyOneDaysAgo;
    }
    if (host == "fresh.example.com") {
      return tenDaysAgo;
    }
    return null;
  };

  const unused = await WhimsySafetyCheck.getUnusedPermissions();
  const stale = unused.find(s => s.origin == staleOrigin);
  ok(stale, "The site not visited in 90 days is unused");
  ok(!unused.some(s => s.origin == freshOrigin), "The one visited 10 days ago is not");
  is(stale.types.length, 2, "Both of its allowed permissions (not the denied one)");
  ok(stale.types.includes("camera") && stale.types.includes("geo"), "camera and geo");

  const result = await WhimsySafetyCheck.checkPermissions();
  is(result.status, "warn", "checkPermissions warns when any site is unused");
  is(result.count, 1, "counting sites, not permissions");
  is(result.typesText, "Camera and location", "a short, capitalized, joined list");

  WhimsySafetyCheck.removePermissions(stale.principal, stale.types);
  const after = await WhimsySafetyCheck.getUnusedPermissions();
  ok(!after.some(s => s.origin == staleOrigin), "Remove takes the site out of the unused list");
  is(Services.perms.testPermissionFromPrincipal(stalePrincipal, "camera"), Services.perms.UNKNOWN_ACTION, "camera is gone");
  is(Services.perms.testPermissionFromPrincipal(stalePrincipal, "geo"), Services.perms.UNKNOWN_ACTION, "geo is gone");

  Services.perms.removeFromPrincipal(freshPrincipal, "microphone");
  Services.perms.removeFromPrincipal(stalePrincipal, "desktop-notification");
});

add_task(async function permissions_ok_when_nothing_unused() {
  WhimsySafetyCheck._lastVisit = () => Date.now();
  const origin = "https://justvisited.example.com";
  const principal = principalFor(origin);
  Services.perms.addFromPrincipal(principal, "camera", Services.perms.ALLOW_ACTION);
  is((await WhimsySafetyCheck.checkPermissions()).status, "ok", "A recently visited site with access: ok");
  Services.perms.removeFromPrincipal(principal, "camera");
});

add_task(function permission_label_list_formatting() {
  is(WhimsySafetyCheck.formatPermissionList(["camera"]), "Camera", "One: capitalized noun, no joiner");
  is(WhimsySafetyCheck.formatPermissionList(["camera", "microphone"]), "Camera and microphone", "Two: joined with 'and'");
  is(
    WhimsySafetyCheck.formatPermissionList(["camera", "geo", "desktop-notification"]),
    "Camera, location, and notifications",
    "Three or more: comma-joined with a serial comma before the last"
  );
});

add_task(async function run_returns_all_four_checks_in_a_fixed_shape() {
  WhimsySafetyCheck._readUpdates = async () => [null, { version: "1.24b-w3.7" }];
  WhimsySafetyCheck._getLogins = async () => [];
  WhimsySafetyCheck._getAddons = async () => [];
  WhimsySafetyCheck._lastVisit = () => Date.now();
  const result = await WhimsySafetyCheck.run();
  for (const key of ["updates", "passwords", "extensions", "permissions"]) {
    ok(result[key] && (result[key].status == "ok" || result[key].status == "warn"), `run() includes ${key}`);
  }
});
