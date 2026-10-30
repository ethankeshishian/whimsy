/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The page half of the Claude space (WhimsyClaude.sys.mjs): reads a page as
// an accessibility-style outline with element refs, finds elements, and
// clicks, types and fills forms in it. It's only registered while the user
// has turned Claude on, only runs in http(s) top-level pages, and only
// answers the parent; it never sends anything on its own.
//
// It never reveals or fills password fields (Whimsy keeps Claude away from
// passwords and the password manager entirely).

const MAX_LINES = 1500;
const MAX_TEXT = 60000;
const MAX_NAME = 100;
const MAX_FIND = 20;

const INTERACTIVE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "clickable",
]);

const LANDMARKS = {
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  form: "form",
  dialog: "dialog",
};

// Roles whose name comes from their own text; their text isn't repeated.
const NAME_FROM_CONTENT = new Set([
  "link",
  "button",
  "heading",
  "option",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "clickable",
  "switch",
]);

// Keys for the key tool: name -> [key, code].
const NAMED_KEYS = {
  enter: ["Enter", "Enter"],
  return: ["Enter", "Enter"],
  tab: ["Tab", "Tab"],
  escape: ["Escape", "Escape"],
  esc: ["Escape", "Escape"],
  backspace: ["Backspace", "Backspace"],
  delete: ["Delete", "Delete"],
  space: [" ", "Space"],
  arrowup: ["ArrowUp", "ArrowUp"],
  arrowdown: ["ArrowDown", "ArrowDown"],
  arrowleft: ["ArrowLeft", "ArrowLeft"],
  arrowright: ["ArrowRight", "ArrowRight"],
  up: ["ArrowUp", "ArrowUp"],
  down: ["ArrowDown", "ArrowDown"],
  left: ["ArrowLeft", "ArrowLeft"],
  right: ["ArrowRight", "ArrowRight"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  pageup: ["PageUp", "PageUp"],
  pagedown: ["PageDown", "PageDown"],
};

const MODIFIERS = {
  cmd: ["Meta", "MetaLeft"],
  meta: ["Meta", "MetaLeft"],
  command: ["Meta", "MetaLeft"],
  ctrl: ["Control", "ControlLeft"],
  control: ["Control", "ControlLeft"],
  alt: ["Alt", "AltLeft"],
  option: ["Alt", "AltLeft"],
  opt: ["Alt", "AltLeft"],
  shift: ["Shift", "ShiftLeft"],
};

function clip(text, max = MAX_NAME) {
  text = (text || "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function isPassword(el) {
  return el?.localName == "input" && (el.type == "password" || /password/i.test(el.autocomplete || ""));
}

export class WhimsyClaudeChild extends JSWindowActorChild {
  #refs = new Map();
  #refOf = new WeakMap();
  #nextRef = 1;

  receiveMessage({ name, data }) {
    try {
      switch (name) {
        case "Claude:ReadPage":
          return this.readPage(data);
        case "Claude:PageText":
          return this.pageText();
        case "Claude:Find":
          return this.find(data);
        case "Claude:Click":
          return this.click(data);
        case "Claude:Type":
          return this.type(data);
        case "Claude:Key":
          return this.key(data);
        case "Claude:FormInput":
          return this.formInput(data);
        case "Claude:Scroll":
          return this.scroll(data);
      }
    } catch (e) {
      return { error: String(e?.message || e) };
    }
    return { error: `Unknown message ${name}` };
  }

  get doc() {
    return this.document;
  }

  // --- Refs ---

  refFor(el) {
    let ref = this.#refOf.get(el);
    if (!ref) {
      ref = `ref_${this.#nextRef++}`;
      this.#refOf.set(el, ref);
      this.#refs.set(ref, new WeakRef(el));
    }
    return ref;
  }

  element(ref) {
    const el = this.#refs.get(String(ref))?.deref();
    if (!el || !el.isConnected) {
      throw new Error(`Unknown or stale ref "${ref}". Call read_page or find again.`);
    }
    return el;
  }

  // --- Roles and names ---

  role(el) {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit && explicit != "presentation" && explicit != "none" && explicit != "generic") {
      return explicit;
    }
    const tag = el.localName;
    switch (tag) {
      case "a":
        return el.hasAttribute("href") ? "link" : null;
      case "button":
      case "summary":
        return "button";
      case "select":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "option":
        return "option";
      case "textarea":
        return "textbox";
      case "input": {
        const type = el.type;
        if (type == "hidden") {
          return null;
        }
        if (["button", "submit", "reset", "image", "file"].includes(type)) {
          return "button";
        }
        if (type == "checkbox" || type == "radio") {
          return type;
        }
        if (type == "range") {
          return "slider";
        }
        if (type == "number") {
          return "spinbutton";
        }
        if (type == "search") {
          return "searchbox";
        }
        return "textbox";
      }
      case "img":
        return "img";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "iframe":
        return "iframe";
      case "table":
        return "table";
    }
    if (LANDMARKS[tag]) {
      return LANDMARKS[tag];
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) {
      return "textbox";
    }
    if (el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.tabIndex >= 0)) {
      return "clickable";
    }
    return null;
  }

  name(el, role) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map(id => this.doc.getElementById(id)?.textContent || "")
        .join(" ");
      if (text.trim()) {
        return clip(text);
      }
    }
    const direct = el.getAttribute("aria-label") || el.getAttribute("alt");
    if (direct?.trim()) {
      return clip(direct);
    }
    if (el.labels?.length) {
      const text = [...el.labels].map(l => l.textContent).join(" ");
      if (text.trim()) {
        return clip(text);
      }
    }
    if (el.localName == "input" && ["button", "submit", "reset"].includes(el.type)) {
      return clip(el.value || el.type);
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const text = clip(el.textContent);
      if (text) {
        return text;
      }
    }
    return clip(el.getAttribute("title") || el.getAttribute("placeholder") || "");
  }

  details(el, role) {
    const parts = [];
    if (role == "heading") {
      parts.push(`level=${el.localName.match(/^h(\d)$/)?.[1] || el.getAttribute("aria-level") || 2}`);
    }
    if (role == "link") {
      parts.push(`href="${clip(el.href, 150)}"`);
    }
    if (el.localName == "input" || el.localName == "textarea") {
      if (el.type == "checkbox" || el.type == "radio") {
        parts.push(el.checked ? "checked" : "unchecked");
      } else if (isPassword(el)) {
        parts.push("password (hidden)");
      } else if (el.value) {
        parts.push(`value="${clip(el.value, 200)}"`);
      }
      if (el.placeholder && el.labels?.length) {
        parts.push(`placeholder="${clip(el.placeholder)}"`);
      }
    }
    if (el.localName == "select") {
      const selected = [...el.selectedOptions].map(o => clip(o.label)).join(", ");
      parts.push(`value="${selected}"`);
      parts.push(`options=[${[...el.options].slice(0, 30).map(o => `"${clip(o.label, 40)}"`).join(", ")}]`);
    }
    for (const state of ["expanded", "selected", "pressed", "checked"]) {
      const value = el.getAttribute(`aria-${state}`);
      if (value == "true" || value == "false") {
        parts.push(`${state}=${value}`);
      }
    }
    if (el.disabled || el.getAttribute("aria-disabled") == "true") {
      parts.push("disabled");
    }
    return parts.join(" ");
  }

  visible(el) {
    if (el.getAttribute("aria-hidden") == "true" || el.hidden) {
      return false;
    }
    if (el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) {
      return true;
    }
    // display: contents has no box but its children do.
    return this.contentWindow.getComputedStyle(el).display == "contents";
  }

  line(el, role, depth) {
    const name = this.name(el, role);
    const details = this.details(el, role);
    return (
      `${"  ".repeat(depth)}- ${role}` +
      (name ? ` "${name.replace(/"/g, "'")}"` : "") +
      (details ? ` ${details}` : "") +
      ` [${this.refFor(el)}]`
    );
  }

  // --- Reading ---

  readPage({ filter = "all", ref } = {}) {
    const root = ref ? this.element(ref) : this.doc.body || this.doc.documentElement;
    const interactiveOnly = filter == "interactive";
    const lines = [];
    let truncated = false;
    const walk = (node, depth, named) => {
      if (lines.length >= MAX_LINES) {
        truncated = true;
        return;
      }
      if (node.nodeType == node.TEXT_NODE) {
        if (!interactiveOnly && !named) {
          const text = clip(node.data, 300);
          if (text) {
            lines.push(`${"  ".repeat(depth)}- text "${text.replace(/"/g, "'")}"`);
          }
        }
        return;
      }
      if (node.nodeType != node.ELEMENT_NODE) {
        return;
      }
      const el = node;
      if (["script", "style", "noscript", "template", "head"].includes(el.localName) || !this.visible(el)) {
        return;
      }
      const role = this.role(el);
      let childDepth = depth;
      if (role && (!interactiveOnly || INTERACTIVE.has(role))) {
        lines.push(this.line(el, role, interactiveOnly ? 0 : depth));
        childDepth = depth + 1;
        named ||= NAME_FROM_CONTENT.has(role);
      }
      // Form controls describe themselves; their insides (a password's real
      // text lives in the input's UA shadow tree) are never read.
      if (["select", "iframe", "textarea", "input"].includes(el.localName)) {
        return;
      }
      for (const child of el.childNodes) {
        walk(child, childDepth, named);
      }
      if (el.openOrClosedShadowRoot && !el.openOrClosedShadowRoot.isUAWidget()) {
        for (const child of el.openOrClosedShadowRoot.childNodes) {
          walk(child, childDepth, named);
        }
      }
    };
    walk(root, 0, false);
    return {
      title: this.doc.title,
      url: this.doc.URL,
      tree: lines.join("\n"),
      truncated,
    };
  }

  pageText() {
    const text = this.doc.body?.innerText || "";
    return {
      title: this.doc.title,
      url: this.doc.URL,
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
      truncated: text.length > MAX_TEXT,
    };
  }

  // Elements whose role, name, value or placeholder contain every word of
  // the query (best matches first), plus elements whose own text does.
  find({ query }) {
    const words = String(query || "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) {
      throw new Error("Empty query");
    }
    const matches = [];
    const seen = new Set();
    const consider = (el, role, haystack) => {
      if (seen.has(el)) {
        return;
      }
      haystack = haystack.toLowerCase();
      const score = words.filter(w => haystack.includes(w)).length;
      if (score == words.length) {
        seen.add(el);
        matches.push({ el, role, score: INTERACTIVE.has(role) ? 2 : 1 });
      }
    };
    const walker = this.doc.createTreeWalker(this.doc.body || this.doc.documentElement, 1 /* SHOW_ELEMENT */);
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (["script", "style", "noscript", "template"].includes(el.localName)) {
        continue;
      }
      const role = this.role(el);
      if (role) {
        if (!this.visible(el)) {
          continue;
        }
        const name = this.name(el, role);
        const extra = isPassword(el) ? "" : el.value || "";
        consider(el, role, `${role} ${name} ${el.getAttribute("placeholder") || ""} ${extra}`);
      } else if (
        [...el.childNodes].some(n => n.nodeType == n.TEXT_NODE && n.data.trim()) &&
        this.visible(el)
      ) {
        const own = [...el.childNodes]
          .filter(n => n.nodeType == n.TEXT_NODE)
          .map(n => n.data)
          .join(" ");
        consider(el, "text", own);
      }
      if (matches.length >= MAX_FIND * 3) {
        break;
      }
    }
    matches.sort((a, b) => b.score - a.score);
    return {
      matches: matches.slice(0, MAX_FIND).map(({ el, role }) =>
        role == "text"
          ? `- text "${clip(el.textContent).replace(/"/g, "'")}" [${this.refFor(el)}]`
          : this.line(el, role, 0)
      ),
    };
  }

  describe(el) {
    const role = this.role(el) || el.localName;
    const name = this.name(el, role) || clip(el.textContent, 60);
    return name ? `${role} "${name}"` : role;
  }

  // --- Acting ---

  get hidden() {
    return this.doc.visibilityState != "visible";
  }

  click({ ref, coordinate, double = false }) {
    const win = this.contentWindow;
    let x, y, el;
    if (ref) {
      el = this.element(ref);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top + rect.height / 2;
    } else if (Array.isArray(coordinate) && coordinate.length == 2) {
      [x, y] = coordinate.map(Number);
    } else {
      throw new Error("Pass a ref or a coordinate [x, y]");
    }
    const target = this.doc.elementFromPoint(x, y) || el;
    if (!target) {
      throw new Error(`Nothing at (${Math.round(x)}, ${Math.round(y)})`);
    }
    // A visible page gets real (trusted) mouse events at the point, like a
    // person's click. A background tab (the Claude space while you're in
    // another space) can't take pointer input, so the element is clicked
    // directly: links, buttons, checkboxes and submits all still work.
    let synthesized = false;
    if (!this.hidden && typeof win.synthesizeMouseEvent == "function") {
      try {
        win.synthesizeMouseEvent("mousemove", x, y, {});
        for (let i = 1; i <= (double ? 2 : 1); i++) {
          win.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: i });
          win.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: i });
        }
        synthesized = true;
      } catch (e) {
        synthesized = false;
      }
    }
    if (!synthesized) {
      const clickable = el && (el == target || el.contains(target)) ? el : target;
      clickable.focus?.();
      clickable.click();
      if (double) {
        clickable.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
      }
    }
    return { clicked: this.describe(target) };
  }

  editable(el) {
    if (!el) {
      return false;
    }
    if (el.localName == "textarea") {
      return !el.readOnly && !el.disabled;
    }
    if (el.localName == "input") {
      return !el.readOnly && !el.disabled && !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color", "hidden"].includes(el.type);
    }
    return el.isContentEditable;
  }

  // Inserts text at the caret of the focused (or given) field, the way an
  // input method does, so the page sees ordinary input events. Works in
  // background tabs too.
  type({ text, ref }) {
    text = String(text ?? "");
    if (ref) {
      this.element(ref).focus();
    }
    const el = this.doc.activeElement;
    if (isPassword(el)) {
      throw new Error("Whimsy doesn't let Claude type into password fields.");
    }
    if (!this.editable(el)) {
      throw new Error("No text field is focused. Click one first, or pass its ref.");
    }
    if (el.localName == "input" || el.localName == "textarea") {
      let start = el.value.length;
      let end = start;
      try {
        start = el.selectionStart ?? start;
        end = el.selectionEnd ?? end;
      } catch (e) {
        // Inputs like email have no selection API.
      }
      el.setUserInput(el.value.slice(0, start) + text + el.value.slice(end));
      try {
        el.setSelectionRange(start + text.length, start + text.length);
      } catch (e) {}
    } else {
      this.doc.execCommand("insertText", false, text);
    }
    return { typed: text.length, into: this.describe(el) };
  }

  // One or more key presses, space-separated: "Enter", "Tab", "cmd+a",
  // "shift+Tab". A visible page gets real keystrokes; a background tab
  // gets the result of the common ones (submit, focus moves, deletes).
  key({ keys }) {
    const presses = String(keys || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 50);
    if (!presses.length) {
      throw new Error("Pass keys, e.g. \"Enter\" or \"cmd+a\"");
    }
    if (isPassword(this.doc.activeElement)) {
      throw new Error("Whimsy doesn't let Claude type into password fields.");
    }
    const win = this.contentWindow;
    let tip = null;
    if (!this.hidden) {
      tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
      if (!tip.beginInputTransactionForTests(win)) {
        tip = null;
      }
    }
    for (const press of presses) {
      const parts = press.split("+");
      const main = parts.pop();
      const mods = parts.map(m => MODIFIERS[m.toLowerCase()]).filter(Boolean);
      const [key, code] = NAMED_KEYS[main.toLowerCase()] || [main, ""];
      if (tip) {
        const event = dict => new win.KeyboardEvent("", dict);
        for (const [mkey, mcode] of mods) {
          tip.keydown(event({ key: mkey, code: mcode }));
        }
        const dict = { key, code: code || tip.guessCodeValueOfPrintableKeyInUSEnglishKeyboardLayout(key) };
        if (key.length == 1) {
          dict.keyCode = tip.guessKeyCodeValueOfPrintableKeyInUSEnglishKeyboardLayout(key);
        }
        tip.keydown(event(dict));
        tip.keyup(event(dict));
        for (const [mkey, mcode] of mods.reverse()) {
          tip.keyup(event({ key: mkey, code: mcode }));
        }
      } else {
        this.emulateKey(key, mods.map(([m]) => m));
      }
    }
    return { pressed: presses };
  }

  emulateKey(key, mods) {
    const win = this.contentWindow;
    const el = this.doc.activeElement || this.doc.body;
    const init = {
      key,
      bubbles: true,
      cancelable: true,
      metaKey: mods.includes("Meta"),
      ctrlKey: mods.includes("Control"),
      altKey: mods.includes("Alt"),
      shiftKey: mods.includes("Shift"),
    };
    const proceed = el.dispatchEvent(new win.KeyboardEvent("keydown", init));
    if (proceed) {
      if (key == "Enter") {
        if (el.form && el.localName == "input") {
          el.form.requestSubmit();
        } else if (el.localName == "a" || el.localName == "button" || this.role(el) == "button") {
          el.click();
        } else if (el.localName == "textarea" || el.isContentEditable) {
          this.type({ text: "\n" });
        }
      } else if (key == "Tab") {
        this.moveFocus(el, init.shiftKey ? -1 : 1);
      } else if (key == "Backspace" && this.editable(el) && (el.localName == "input" || el.localName == "textarea")) {
        const end = el.selectionEnd ?? el.value.length;
        const start = el.selectionStart == end ? Math.max(0, end - 1) : el.selectionStart;
        el.setUserInput(el.value.slice(0, start) + el.value.slice(end));
      } else if (key.length == 1 && !init.metaKey && !init.ctrlKey && this.editable(el)) {
        this.type({ text: key });
      }
    }
    el.dispatchEvent(new win.KeyboardEvent("keyup", init));
  }

  moveFocus(from, direction) {
    const focusable = [
      ...this.doc.querySelectorAll("a[href], button, input, select, textarea, [tabindex], [contenteditable]"),
    ].filter(el => el.tabIndex >= 0 && !el.disabled && this.visible(el));
    const index = focusable.indexOf(from);
    const next = focusable[(index + direction + focusable.length) % focusable.length];
    next?.focus();
  }

  formInput({ ref, value }) {
    const el = this.element(ref);
    const win = this.contentWindow;
    if (isPassword(el)) {
      throw new Error("Whimsy doesn't let Claude fill password fields.");
    }
    if (el.disabled) {
      throw new Error("That field is disabled.");
    }
    if (el.localName == "select") {
      const wanted = Array.isArray(value) ? value.map(String) : [String(value)];
      let found = 0;
      for (const option of el.options) {
        const match = wanted.includes(option.value) || wanted.includes(option.label.trim());
        if (match) {
          found++;
        }
        if (el.multiple || match) {
          option.selected = match;
        }
      }
      if (!found) {
        throw new Error(`No option matches ${JSON.stringify(value)}.`);
      }
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
      return { set: this.describe(el), value: [...el.selectedOptions].map(o => o.label) };
    }
    if (el.localName == "input" && (el.type == "checkbox" || el.type == "radio")) {
      const want = value === true || value === "true" || value === "on" || value === 1;
      if (el.checked != want && !(el.type == "radio" && !want)) {
        el.click();
      }
      return { set: this.describe(el), checked: el.checked };
    }
    if (el.localName == "input" || el.localName == "textarea") {
      el.focus();
      el.setUserInput(String(value ?? ""));
      return { set: this.describe(el), value: el.value };
    }
    if (el.isContentEditable) {
      el.focus();
      this.doc.execCommand("selectAll");
      this.doc.execCommand("insertText", false, String(value ?? ""));
      return { set: this.describe(el) };
    }
    throw new Error("That element isn't a form field.");
  }

  scroll({ direction = "down", amount = 1, ref }) {
    const win = this.contentWindow;
    if (ref) {
      this.element(ref).scrollIntoView({ block: "center", behavior: "instant" });
    } else {
      const pages = Math.max(0.1, Math.min(20, Number(amount) || 1));
      const dy = { down: 1, up: -1 }[direction] || 0;
      const dx = { right: 1, left: -1 }[direction] || 0;
      win.scrollBy({
        top: dy * win.innerHeight * 0.8 * pages,
        left: dx * win.innerWidth * 0.8 * pages,
        behavior: "instant",
      });
    }
    return { scrollX: Math.round(win.scrollX), scrollY: Math.round(win.scrollY) };
  }
}
