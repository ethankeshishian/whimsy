/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// meeting: the "Meetings" tab of the Library sidebar. The next 24 hours of
// meetings, soonest first, each with a Join button when it carries a
// Meet/Zoom/Teams/Webex link, and the calendars they come from: Apple
// Calendar (asks macOS for access only when turned on here or in Settings)
// and any number of Google Calendar secret addresses.

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";

// The service is shared by every window (one refresh timer, one cache), so
// it loads in the shared global even though this section loads per window.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyNextMeeting: "resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs",
});

const GOOGLE_HELP_URL = "https://calendar.google.com/calendar/r/settings";
const PRIVACY_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars";

function openSystemCalendarPrivacy() {
  try {
    const open = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    open.initWithPath("/usr/bin/open");
    const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    process.init(open);
    process.runAsync([PRIVACY_PANE], 1);
  } catch (e) {
    console.error("Whimsy: open Calendar privacy settings", e);
  }
}

export class WhimsyNextMeetingSection extends ZenLibrarySearchSection {
  static id = "whimsy-next-meeting";
  static label = "whimsy-library-meetings-title";

  static render(library) {
    return html`
      <whimsy-library-meetings-section
        class="zen-library-section"
        data-section="whimsy-next-meeting"
        .library=${library}
      ></whimsy-library-meetings-section>
    `;
  }

  static properties = {
    adding: { state: true },
    addError: { state: true },
  };

  #listener = () => this.requestUpdate();

  constructor() {
    super();
    this.adding = false;
    this.addError = false;
  }

  connectedCallback() {
    super.connectedCallback();
    lazy.WhimsyNextMeeting.addListener(this.#listener);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    lazy.WhimsyNextMeeting.removeListener(this.#listener);
  }

  async onShown() {
    await super.onShown?.();
    // Apple Calendar is local, so opening the tab re-reads it; Google
    // calendars keep their 5-minute limit.
    lazy.WhimsyNextMeeting.refresh({ apple: true });
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-meetings-search-placeholder";
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  #matches(event) {
    const query = this.searchQuery.toLowerCase();
    return !query || (event.title || "").toLowerCase().includes(query);
  }

  #renderMeeting(event, now) {
    const service = lazy.WhimsyNextMeeting;
    const until = service.formatUntil(event, now);
    return html`
      <div
        class="zen-library-row whimsy-meeting-row"
        ?whimsy-meeting-live=${!until}
        data-meeting-id=${event.id}
        @click=${() => service.join(this.documentGlobal, event)}
      >
        <span
          class="whimsy-meeting-dot"
          style=${event.color ? `background-color: ${event.color}` : ""}
        ></span>
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${event.title}</span>
          <span class="zen-library-row-subtitle">
            <span>${service.formatRange(event)}</span>
            ${until
              ? html`<span class="whimsy-meeting-until">${until}</span>`
              : html`<span class="whimsy-meeting-until" data-l10n-id="whimsy-meeting-now"></span>`}
            ${event.sourceLabel ? html`<span>${event.sourceLabel}</span>` : ""}
          </span>
        </div>
        ${event.join
          ? html`<button
              class="whimsy-meeting-join"
              data-service=${event.join.service}
              data-l10n-id="whimsy-meeting-join"
              @click=${e => {
                e.stopPropagation();
                service.join(this.documentGlobal, event);
              }}
            ></button>`
          : ""}
      </div>
    `;
  }

  #renderAppleSource() {
    const service = lazy.WhimsyNextMeeting;
    if (!service.appleAvailable) {
      return "";
    }
    const status = service.appleStatus;
    let detail = "";
    let action = "";
    if (status == "off") {
      action = html`<button
        class="whimsy-meeting-source-action"
        data-l10n-id="whimsy-meeting-apple-connect"
        @click=${() => service.setAppleEnabled(true)}
      ></button>`;
    } else if (status == "notDetermined") {
      action = html`<button
        class="whimsy-meeting-source-action"
        data-l10n-id="whimsy-meeting-apple-allow"
        @click=${() => service.requestAppleAccess()}
      ></button>`;
    } else if (status == "denied" || status == "restricted" || status == "writeOnly") {
      detail = "whimsy-meeting-apple-denied";
      action = html`<button
        class="whimsy-meeting-source-action"
        data-l10n-id="whimsy-meeting-apple-open-settings"
        @click=${() => openSystemCalendarPrivacy()}
      ></button>`;
    } else if (status == "missing-usage-description") {
      detail = "whimsy-meeting-apple-unsupported";
    }
    return html`
      <div class="zen-library-row whimsy-meeting-source" data-source="apple" data-status=${status}>
        <img class="zen-library-row-icon" src="chrome://browser/skin/zen-icons/selectable/time.svg" alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title" data-l10n-id="whimsy-meeting-apple-title"></span>
          ${detail ? html`<span class="zen-library-row-subtitle" data-l10n-id=${detail}></span>` : ""}
        </div>
        ${action}
        ${status != "off"
          ? html`<div class="zen-library-row-actions">
              <toolbarbutton
                class="toolbarbutton-1"
                data-l10n-id="whimsy-meeting-source-remove"
                @click=${() => service.setAppleEnabled(false)}
              >
                <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/close.svg" alt="" />
              </toolbarbutton>
            </div>`
          : ""}
      </div>
    `;
  }

  #renderGoogleSource(calendar) {
    const service = lazy.WhimsyNextMeeting;
    const error = service.sourceState(`google:${calendar.id}`)?.error;
    return html`
      <div class="zen-library-row whimsy-meeting-source" data-source="google" data-calendar-id=${calendar.id}>
        <img class="zen-library-row-icon" src="chrome://browser/skin/zen-icons/selectable/time.svg" alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${calendar.label || calendar.url}</span>
          <span
            class="zen-library-row-subtitle"
            data-l10n-id=${error ? "whimsy-meeting-google-error" : "whimsy-meeting-google-title"}
          ></span>
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton
            class="toolbarbutton-1"
            data-l10n-id="whimsy-meeting-source-remove"
            @click=${() => service.removeGoogleCalendar(calendar.id)}
          >
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/close.svg" alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
  }

  #submitGoogle(event) {
    event.preventDefault();
    const input = this.querySelector(".whimsy-meeting-add-input");
    if (!input) {
      return;
    }
    if (lazy.WhimsyNextMeeting.addGoogleCalendar(input.value)) {
      input.value = "";
      this.adding = false;
      this.addError = false;
    } else {
      this.addError = true;
    }
  }

  #renderAddForm() {
    if (!this.adding) {
      return "";
    }
    return html`
      <form class="whimsy-meeting-add" @submit=${e => this.#submitGoogle(e)}>
        <input
          class="whimsy-meeting-add-input"
          type="url"
          data-l10n-id="whimsy-meeting-google-placeholder"
          ?invalid=${this.addError}
          @input=${() => (this.addError = false)}
        />
        <div class="whimsy-meeting-add-buttons">
          <button
            type="button"
            class="whimsy-meeting-help"
            data-l10n-id="whimsy-meeting-google-help"
            @click=${() => this.documentGlobal.openTrustedLinkIn(GOOGLE_HELP_URL, "tab")}
          ></button>
          <button type="submit" class="whimsy-meeting-source-action" data-l10n-id="whimsy-meeting-google-add-confirm"></button>
        </div>
        ${this.addError
          ? html`<span class="whimsy-meeting-add-error" data-l10n-id="whimsy-meeting-google-invalid"></span>`
          : ""}
      </form>
    `;
  }

  renderItems() {
    const service = lazy.WhimsyNextMeeting;
    const now = Date.now();
    const meetings = service.upcoming(now).filter(event => this.#matches(event));
    const calendars = service.googleCalendars;
    return html`
      <div class="zen-library-group whimsy-meeting-list">
        ${service.hasSources
          ? meetings.length
            ? repeat(meetings, event => event.id, event => this.#renderMeeting(event, now))
            : html`<div class="zen-library-empty" data-l10n-id="whimsy-library-meetings-empty"></div>`
          : html`<div class="zen-library-empty" data-l10n-id="whimsy-library-meetings-connect"></div>`}
      </div>
      <div class="zen-library-group whimsy-meeting-sources">
        <h3 data-l10n-id="whimsy-meeting-calendars"></h3>
        ${this.#renderAppleSource()}
        ${repeat(calendars, calendar => calendar.id, calendar => this.#renderGoogleSource(calendar))}
        ${this.#renderAddForm()}
      </div>
    `;
  }

  renderFooter() {
    return html`
      <button
        class="zen-library-filter-button whimsy-meeting-add-google"
        @click=${async () => {
          this.adding = !this.adding;
          await this.updateComplete;
          this.querySelector(".whimsy-meeting-add-input")?.focus();
        }}
      >
        <img src="chrome://browser/skin/zen-icons/plus.svg" alt="" />
        <span data-l10n-id="whimsy-meeting-google-add"></span>
      </button>
    `;
  }
}

customElements.define("whimsy-library-meetings-section", WhimsyNextMeetingSection);
