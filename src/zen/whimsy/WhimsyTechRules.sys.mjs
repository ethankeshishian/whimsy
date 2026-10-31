/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave9/pagedev: the "Built With" ruleset (W9-11).
//
// A small, local version of what Wappalyzer and BuiltWith do: each rule
// names a technology, its category and the signs that give it away. The
// content actor (WhimsyPageDevChild) collects only the signals these
// rules ask for (requirements()), from the page itself and the response
// headers the tab already has, and detect() matches them. Nothing leaves
// the device.
//
// A rule (keep `name` first in each entry):
//   name      shown as is (product names are not translated)
//   key       stable id
//   category  one of CATEGORIES (its label is whimsy-pagedev-category-<c>)
//   generator RegExp on <meta name="generator">; group 1 is the version
//   globals   window properties, dotted for nested data properties
//             ("Static.SQUARESPACE_CONTEXT"); only own data properties are
//             followed, so no page getter ever runs
//   version   a dotted global path whose string value is the version
//   prefixes  window property name prefixes ("__sveltekit_")
//   selectors CSS selectors; versionAttr reads the version from the match
//   expando   RegExp on own property names of a sample of elements
//             (React's "__reactFiber$…", Vue's "__vue_app__")
//   urls      RegExp on script, stylesheet and loaded resource URLs
//   headers   { header: RegExp } on the document's response headers;
//             group 1 is the version
//   cssVars   custom properties set on the root element
//   classes   { pattern, min }: at least `min` distinct class names match
//
// Adding a technology is one entry below; the test checks the shape.

export const CATEGORIES = [
  "js-framework",
  "js-library",
  "cms",
  "ecommerce",
  "site-builder",
  "static-site",
  "css-framework",
  "analytics",
  "tag-manager",
  "font-service",
  "cdn",
  "hosting",
  "web-server",
  "backend",
];

export const RULES = [
  // JavaScript frameworks
  {
    name: "React",
    key: "react",
    category: "js-framework",
    globals: ["React"],
    version: "React.version",
    selectors: ["[data-reactroot]"],
    expando: /^(?:__reactFiber\$|__reactContainer\$|_reactRootContainer$|__reactInternalInstance\$)/,
  },
  {
    name: "Next.js",
    key: "nextjs",
    category: "js-framework",
    globals: ["__NEXT_DATA__", "next"],
    version: "next.version",
    selectors: ["#__next", "script#__NEXT_DATA__"],
    urls: [/\/_next\/static\//],
    headers: { "x-powered-by": /^Next\.js(?:\s+([\d.]+))?/i },
  },
  {
    name: "Vue.js",
    key: "vue",
    category: "js-framework",
    globals: ["Vue", "__VUE__"],
    version: "Vue.version",
    selectors: ["[data-v-app]"],
    expando: /^(?:__vue_app__|__vue__|__vueParentComponent)$/,
  },
  {
    name: "Nuxt",
    key: "nuxt",
    category: "js-framework",
    globals: ["__NUXT__", "$nuxt", "useNuxtApp"],
    selectors: ["#__nuxt", "#__layout"],
    urls: [/\/_nuxt\//],
  },
  {
    name: "Svelte",
    key: "svelte",
    category: "js-framework",
    globals: ["__svelte"],
    classes: { pattern: /^svelte-[a-z0-9]{5,8}$/, min: 1 },
  },
  {
    name: "SvelteKit",
    key: "sveltekit",
    category: "js-framework",
    prefixes: ["__sveltekit_"],
    selectors: ["[data-sveltekit-preload-data]", "[data-sveltekit-reload]"],
    urls: [/\/_app\/immutable\//],
  },
  {
    name: "Angular",
    key: "angular",
    category: "js-framework",
    globals: ["ng", "getAllAngularRootElements"],
    selectors: ["[ng-version]"],
    versionAttr: "ng-version",
  },
  {
    name: "AngularJS",
    key: "angularjs",
    category: "js-framework",
    globals: ["angular"],
    version: "angular.version.full",
    selectors: ["[ng-app]", "[data-ng-app]"],
  },
  {
    name: "Astro",
    key: "astro",
    category: "js-framework",
    generator: /^Astro\s*v?([\d.]+)?/i,
    selectors: ["astro-island", "astro-slot"],
  },
  {
    name: "Gatsby",
    key: "gatsby",
    category: "js-framework",
    generator: /^Gatsby\s*([\d.]+)?/i,
    selectors: ["#___gatsby"],
  },
  {
    name: "Remix",
    key: "remix",
    category: "js-framework",
    globals: ["__remixContext", "__remixManifest"],
  },
  {
    name: "Ember.js",
    key: "ember",
    category: "js-framework",
    globals: ["Ember"],
    version: "Ember.VERSION",
    selectors: [".ember-application"],
  },
  {
    name: "Preact",
    key: "preact",
    category: "js-framework",
    expando: /^__k$|^__preactattr_$/,
  },
  // JavaScript libraries
  {
    name: "jQuery",
    key: "jquery",
    category: "js-library",
    globals: ["jQuery"],
    version: "jQuery.fn.jquery",
    urls: [/jquery[.-]?([\d.]+)?(?:\.min)?\.js/i],
  },
  {
    name: "Alpine.js",
    key: "alpine",
    category: "js-library",
    globals: ["Alpine"],
    version: "Alpine.version",
    selectors: ["[x-data]"],
  },
  {
    name: "htmx",
    key: "htmx",
    category: "js-library",
    globals: ["htmx"],
    version: "htmx.version",
    selectors: ["[hx-get]", "[hx-post]", "[data-hx-get]"],
  },
  {
    name: "GSAP",
    key: "gsap",
    category: "js-library",
    globals: ["gsap"],
    version: "gsap.version",
  },
  // CMS, shops and site builders
  {
    name: "WordPress",
    key: "wordpress",
    category: "cms",
    generator: /^WordPress\s*([\d.]+)?/i,
    globals: ["wp", "wpApiSettings"],
    urls: [/\/wp-(?:content|includes)\//],
    selectors: ['link[rel="https://api.w.org/"]'],
  },
  {
    name: "Drupal",
    key: "drupal",
    category: "cms",
    generator: /^Drupal\s*([\d.]+)?/i,
    globals: ["Drupal", "drupalSettings"],
    headers: { "x-generator": /^Drupal\s*([\d.]+)?/i },
  },
  {
    name: "Joomla",
    key: "joomla",
    category: "cms",
    generator: /^Joomla!?/i,
  },
  {
    name: "Ghost",
    key: "ghost",
    category: "cms",
    generator: /^Ghost\s*([\d.]+)?/i,
  },
  {
    name: "Shopify",
    key: "shopify",
    category: "ecommerce",
    globals: ["Shopify", "ShopifyAnalytics"],
    urls: [/cdn\.shopify\.com\//, /\/cdn\/shop\//],
    headers: { "x-shopid": /./, "x-shopify-stage": /./ },
  },
  {
    name: "WooCommerce",
    key: "woocommerce",
    category: "ecommerce",
    generator: /^WooCommerce\s*([\d.]+)?/i,
    globals: ["woocommerce_params", "wc_add_to_cart_params"],
    urls: [/\/plugins\/woocommerce\//],
  },
  {
    name: "Webflow",
    key: "webflow",
    category: "site-builder",
    generator: /^Webflow/i,
    globals: ["Webflow"],
    selectors: ["html[data-wf-site]", "html[data-wf-page]"],
    urls: [/assets(?:-global)?\.website-files\.com\//, /\.webflow\.(?:io|com)\//],
  },
  {
    name: "Squarespace",
    key: "squarespace",
    category: "site-builder",
    globals: ["Squarespace", "Static.SQUARESPACE_CONTEXT"],
    urls: [/static1?\.squarespace\.com\//, /\.sqspcdn\.com\//],
  },
  {
    name: "Wix",
    key: "wix",
    category: "site-builder",
    generator: /^Wix\.com/i,
    globals: ["wixBiSession", "wixPerformanceMeasurements"],
    urls: [/static\.(?:wixstatic|parastorage)\.com\//],
    headers: { "x-wix-request-id": /./ },
  },
  {
    name: "Framer",
    key: "framer",
    category: "site-builder",
    generator: /^Framer\s*([\w.]+)?/i,
    urls: [/framerusercontent\.com\//, /framer\.com\/m\//],
  },
  {
    name: "Hugo",
    key: "hugo",
    category: "static-site",
    generator: /^Hugo\s*([\d.]+)?/i,
  },
  {
    name: "Jekyll",
    key: "jekyll",
    category: "static-site",
    generator: /^Jekyll\s*v?([\d.]+)?/i,
  },
  {
    name: "Docusaurus",
    key: "docusaurus",
    category: "static-site",
    generator: /^Docusaurus\s*v?([\d.]+)?/i,
  },
  // CSS frameworks
  {
    name: "Tailwind CSS",
    key: "tailwind",
    category: "css-framework",
    cssVars: ["--tw-ring-offset-width", "--tw-border-spacing-x", "--tw-translate-x", "--tw-shadow"],
    // Shapes only Tailwind writes: variant prefixes ("md:flex"), palette
    // steps ("bg-sky-500"), arbitrary values ("w-[42px]"). Bootstrap's
    // "mb-3" and "text-center" don't count.
    classes: {
      pattern:
        /^(?:(?:sm|md|lg|xl|2xl|hover|focus|active|dark|group-hover|disabled|first|last|motion-safe|motion-reduce):)+\S|^-?(?:text|bg|border|ring|from|to|via|fill|stroke|outline|decoration|divide|placeholder|accent|caret|shadow)-[a-z]+-\d{2,3}(?:\/\d+)?$|^[a-z-]+-\[[^\]]+\]$|^space-[xy]-\d|^rounded-(?:md|xl|2xl|3xl)$|^tracking-(?:tight|tighter|wide|wider|widest)$/,
      min: 8,
    },
  },
  {
    name: "Bootstrap",
    key: "bootstrap",
    category: "css-framework",
    globals: ["bootstrap"],
    version: "bootstrap.Tooltip.VERSION",
    cssVars: ["--bs-blue", "--bs-body-font-family"],
    urls: [/bootstrap(?:[.-][\d.]+)?(?:\.bundle)?(?:\.min)?\.(?:css|js)/i],
  },
  {
    name: "Bulma",
    key: "bulma",
    category: "css-framework",
    cssVars: ["--bulma-scheme-main"],
    urls: [/bulma(?:\.min)?\.css/i],
  },
  // Analytics and tag managers
  {
    name: "Google Analytics",
    key: "google-analytics",
    category: "analytics",
    globals: ["gtag", "ga", "GoogleAnalyticsObject"],
    urls: [/google-analytics\.com\/(?:analytics|ga|g\/collect)/, /googletagmanager\.com\/gtag\/js/],
  },
  {
    name: "Google Tag Manager",
    key: "google-tag-manager",
    category: "tag-manager",
    globals: ["google_tag_manager"],
    urls: [/googletagmanager\.com\/gtm\.js/],
  },
  {
    name: "Segment",
    key: "segment",
    category: "analytics",
    urls: [/cdn\.segment\.(?:com|io)\//],
  },
  {
    name: "Plausible",
    key: "plausible",
    category: "analytics",
    globals: ["plausible"],
    urls: [/plausible\.io\/js\//],
  },
  {
    name: "Fathom",
    key: "fathom",
    category: "analytics",
    globals: ["fathom"],
    urls: [/cdn\.usefathom\.com\//],
  },
  {
    name: "Mixpanel",
    key: "mixpanel",
    category: "analytics",
    globals: ["mixpanel"],
    urls: [/cdn\.mxpnl\.com\//, /mixpanel\.com\/track/],
  },
  {
    name: "Hotjar",
    key: "hotjar",
    category: "analytics",
    globals: ["hj", "hjSiteSettings"],
    urls: [/static\.hotjar\.com\//],
  },
  {
    name: "PostHog",
    key: "posthog",
    category: "analytics",
    globals: ["posthog"],
    urls: [/\.posthog\.com\/static\//],
  },
  {
    name: "Matomo",
    key: "matomo",
    category: "analytics",
    globals: ["_paq", "Matomo", "Piwik"],
    urls: [/\/matomo\.js/, /\/piwik\.js/],
  },
  {
    name: "Microsoft Clarity",
    key: "clarity",
    category: "analytics",
    urls: [/clarity\.ms\/tag\//],
  },
  {
    name: "Meta Pixel",
    key: "meta-pixel",
    category: "analytics",
    globals: ["fbq"],
    urls: [/connect\.facebook\.net\/[\w_]+\/fbevents\.js/],
  },
  {
    name: "Vercel Analytics",
    key: "vercel-analytics",
    category: "analytics",
    urls: [/\/_vercel\/insights\//, /\/_vercel\/speed-insights\//],
  },
  {
    name: "Cloudflare Web Analytics",
    key: "cloudflare-analytics",
    category: "analytics",
    urls: [/static\.cloudflareinsights\.com\//],
  },
  // Font services
  {
    name: "Google Fonts",
    key: "google-fonts",
    category: "font-service",
    urls: [/fonts\.(?:googleapis|gstatic)\.com\//],
  },
  {
    name: "Adobe Fonts",
    key: "adobe-fonts",
    category: "font-service",
    urls: [/use\.typekit\.net\//, /p\.typekit\.net\//],
  },
  // CDNs and hosting
  {
    name: "Cloudflare",
    key: "cloudflare",
    category: "cdn",
    headers: { "cf-ray": /./, server: /^cloudflare$/i },
    urls: [/cdnjs\.cloudflare\.com\//],
  },
  {
    name: "Fastly",
    key: "fastly",
    category: "cdn",
    headers: { "x-fastly-request-id": /./, "fastly-debug-digest": /./, "x-served-by": /^cache-/ },
  },
  {
    name: "Amazon CloudFront",
    key: "cloudfront",
    category: "cdn",
    headers: { "x-amz-cf-id": /./, via: /CloudFront/i },
    urls: [/\.cloudfront\.net\//],
  },
  {
    name: "Akamai",
    key: "akamai",
    category: "cdn",
    headers: { "x-akamai-transformed": /./, server: /^AkamaiGHost/i },
    urls: [/\.akamai(?:zed|hd)\.net\//],
  },
  {
    name: "jsDelivr",
    key: "jsdelivr",
    category: "cdn",
    urls: [/cdn\.jsdelivr\.net\//],
  },
  {
    name: "unpkg",
    key: "unpkg",
    category: "cdn",
    urls: [/unpkg\.com\//],
  },
  {
    name: "Vercel",
    key: "vercel",
    category: "hosting",
    headers: { "x-vercel-id": /./, server: /^Vercel$/i },
  },
  {
    name: "Netlify",
    key: "netlify",
    category: "hosting",
    headers: { "x-nf-request-id": /./, server: /^Netlify$/i },
  },
  {
    name: "GitHub Pages",
    key: "github-pages",
    category: "hosting",
    headers: { "x-github-request-id": /./, server: /^GitHub\.com$/i },
  },
  // Web servers and back ends
  {
    name: "nginx",
    key: "nginx",
    category: "web-server",
    headers: { server: /^nginx(?:\/([\d.]+))?/i },
  },
  {
    name: "Apache",
    key: "apache",
    category: "web-server",
    headers: { server: /^Apache(?:\/([\d.]+))?/i },
  },
  {
    name: "Caddy",
    key: "caddy",
    category: "web-server",
    headers: { server: /^Caddy/i },
  },
  {
    name: "LiteSpeed",
    key: "litespeed",
    category: "web-server",
    headers: { server: /^LiteSpeed/i },
  },
  {
    name: "Microsoft IIS",
    key: "iis",
    category: "web-server",
    headers: { server: /^Microsoft-IIS(?:\/([\d.]+))?/i },
  },
  {
    name: "Express",
    key: "express",
    category: "backend",
    headers: { "x-powered-by": /^Express/i },
  },
  {
    name: "PHP",
    key: "php",
    category: "backend",
    headers: { "x-powered-by": /^PHP(?:\/([\d.]+))?/i },
  },
  {
    name: "ASP.NET",
    key: "aspnet",
    category: "backend",
    headers: { "x-powered-by": /^ASP\.NET/i, "x-aspnet-version": /^([\d.]+)/ },
  },
];

// A version string from the page is shown and copied; accept only what
// looks like one.
const VERSION_RE = /^v?\d[\w.+-]{0,30}$/;

function cleanVersion(value) {
  if (typeof value != "string") {
    return null;
  }
  const v = value.trim();
  return VERSION_RE.test(v) ? v.replace(/^v/, "") : null;
}

function short(value, max = 120) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export const WhimsyTechRules = {
  RULES,
  CATEGORIES,

  /**
   * What the content side has to look up for the rules: global paths
   * (including version paths), global prefixes, selectors, css vars and
   * whether any rule needs element expandos or class names.
   */
  requirements(rules = RULES) {
    const globals = new Set();
    const prefixes = new Set();
    const selectors = new Set();
    const cssVars = new Set();
    let expando = false;
    let classes = false;
    for (const rule of rules) {
      rule.globals?.forEach(g => globals.add(g));
      if (rule.version) {
        globals.add(rule.version);
      }
      rule.prefixes?.forEach(p => prefixes.add(p));
      rule.selectors?.forEach(s => selectors.add(s));
      rule.cssVars?.forEach(v => cssVars.add(v));
      expando ||= !!rule.expando;
      classes ||= !!rule.classes;
    }
    return {
      globals: [...globals],
      prefixes: [...prefixes],
      selectors: [...selectors],
      cssVars: [...cssVars],
      expando,
      classes,
    };
  },

  /**
   * Matches collected signals against the rules.
   *
   * @param {object} signals
   * @param {string[]} [signals.generators] meta generator contents
   * @param {object} [signals.globals] { path: string value | true }
   * @param {string[]} [signals.globalNames] own window property names
   * @param {object} [signals.selectors] { selector: attribute value map or true }
   * @param {string[]} [signals.expandos] element own property names seen
   * @param {string[]} [signals.urls] resource URLs
   * @param {object} [signals.headers] { lower-case name: value }
   * @param {object} [signals.cssVars] { name: value }
   * @param {string[]} [signals.classes] distinct class names
   * @returns {Array<{key, name, category, version, evidence: Array<{kind, detail}>}>}
   */
  detect(signals, rules = RULES) {
    const s = {
      generators: signals?.generators ?? [],
      globals: signals?.globals ?? {},
      globalNames: signals?.globalNames ?? [],
      selectors: signals?.selectors ?? {},
      expandos: signals?.expandos ?? [],
      urls: signals?.urls ?? [],
      headers: signals?.headers ?? {},
      cssVars: signals?.cssVars ?? {},
      classes: signals?.classes ?? [],
    };
    const found = [];
    for (const rule of rules) {
      const evidence = [];
      let version = null;
      const take = v => {
        version ??= cleanVersion(v);
      };

      if (rule.generator) {
        for (const content of s.generators) {
          const m = rule.generator.exec(content);
          if (m) {
            evidence.push({ kind: "generator", detail: short(content) });
            take(m[1]);
            break;
          }
        }
      }
      for (const path of rule.globals ?? []) {
        if (path in s.globals) {
          evidence.push({ kind: "global", detail: `window.${path}` });
          break;
        }
      }
      if (rule.version && typeof s.globals[rule.version] == "string") {
        take(s.globals[rule.version]);
      }
      for (const prefix of rule.prefixes ?? []) {
        const name = s.globalNames.find(n => n.startsWith(prefix));
        if (name) {
          evidence.push({ kind: "global", detail: `window.${short(name, 60)}` });
          break;
        }
      }
      for (const selector of rule.selectors ?? []) {
        const hit = s.selectors[selector];
        if (hit) {
          evidence.push({ kind: "selector", detail: selector });
          if (rule.versionAttr && typeof hit == "object") {
            take(hit[rule.versionAttr]);
          }
          break;
        }
      }
      if (rule.expando) {
        const name = s.expandos.find(n => rule.expando.test(n));
        if (name) {
          evidence.push({ kind: "expando", detail: short(name.replace(/\$.*/, "$…"), 60) });
        }
      }
      for (const re of rule.urls ?? []) {
        const url = s.urls.find(u => re.test(u));
        if (url) {
          evidence.push({ kind: "resource", detail: short(url) });
          take(re.exec(url)?.[1]);
          break;
        }
      }
      for (const [header, re] of Object.entries(rule.headers ?? {})) {
        const value = s.headers[header];
        if (typeof value == "string") {
          const m = re.exec(value);
          if (m) {
            evidence.push({ kind: "header", detail: short(`${header}: ${value}`) });
            take(m[1]);
          }
        }
      }
      for (const name of rule.cssVars ?? []) {
        if (s.cssVars[name]) {
          evidence.push({ kind: "css-var", detail: name });
          break;
        }
      }
      if (rule.classes) {
        const matching = s.classes.filter(c => rule.classes.pattern.test(c));
        if (matching.length >= rule.classes.min) {
          evidence.push({
            kind: "classes",
            detail: short(matching.slice(0, 4).join(" "), 80),
            count: matching.length,
          });
        }
      }

      if (evidence.length) {
        found.push({ key: rule.key, name: rule.name, category: rule.category, version, evidence });
      }
    }
    // Most evidence first within a category; categories in CATEGORIES order.
    const order = new Map(CATEGORIES.map((c, i) => [c, i]));
    found.sort(
      (a, b) =>
        (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) ||
        b.evidence.length - a.evidence.length ||
        a.name.localeCompare(b.name)
    );
    return found;
  },
};
