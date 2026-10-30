/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Library -> Playlist (whimsy.feature.playlist): saved media, newest first.
// Click a row to play it in place (the downloaded file when it's offline,
// resuming where it stopped); each row says "Saved link", "Downloading" or
// "Available offline" and can open the source page or be removed.

import { html, repeat } from "chrome://global/content/vendor/lit.all.mjs";
import { ZenLibrarySearchSection } from "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";

const { WhimsyPlaylist, PLAYLIST_CHANGED_TOPIC } = ChromeUtils.importESModule(
  "resource:///modules/whimsy/WhimsyPlaylist.sys.mjs"
);

const STATE_L10N = {
  link: "whimsy-playlist-state-link",
  downloading: "whimsy-playlist-state-downloading",
  offline: "whimsy-playlist-state-offline",
  failed: "whimsy-playlist-state-failed",
};

export class WhimsyPlaylistSection extends ZenLibrarySearchSection {
  static id = "whimsy-playlist";
  static label = "whimsy-library-playlist-title";

  static render(library) {
    return html`
      <whimsy-library-playlist-section
        class="zen-library-section"
        data-section="whimsy-playlist"
        .library=${library}
      ></whimsy-library-playlist-section>
    `;
  }

  static properties = {
    items: { state: true },
    playingId: { state: true },
  };

  #observer = { observe: () => this.#refresh() };

  constructor() {
    super();
    this.items = [];
    this.playingId = null;
  }

  connectedCallback() {
    super.connectedCallback();
    Services.obs.addObserver(this.#observer, PLAYLIST_CHANGED_TOPIC);
    this.#refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    Services.obs.removeObserver(this.#observer, PLAYLIST_CHANGED_TOPIC);
  }

  async #refresh() {
    this.items = await WhimsyPlaylist.list();
  }

  get searchPlaceholderL10nId() {
    return "whimsy-library-playlist-search";
  }

  onSearchChanged() {
    this.requestUpdate();
  }

  #matches(item) {
    const q = (this.searchQuery ?? "").toLowerCase();
    return !q || item.title.toLowerCase().includes(q) || item.site.toLowerCase().includes(q);
  }

  #openPage(item) {
    this.ownerDocument.defaultView.openTrustedLinkIn(item.pageURL || item.url, "tab");
  }

  #renderPlayer(item) {
    const onReady = e => {
      if (item.position > 1 && item.position < e.target.duration - 2) {
        e.target.currentTime = item.position;
      }
    };
    const onPause = e => WhimsyPlaylist.savePosition(item.id, e.target.currentTime);
    const src = WhimsyPlaylist.playbackURL(item);
    return item.type == "audio"
      ? html`<audio class="whimsy-playlist-player" controls autoplay src=${src}
          @loadedmetadata=${onReady} @pause=${onPause}></audio>`
      : html`<video class="whimsy-playlist-player" controls autoplay src=${src}
          @loadedmetadata=${onReady} @pause=${onPause}></video>`;
  }

  #renderItem(item) {
    const playing = this.playingId == item.id;
    const toggle = () => (this.playingId = playing ? null : item.id);
    return html`
      <div class="zen-library-row whimsy-playlist-row" role="button" tabindex="0" ?playing=${playing}
           @click=${toggle} @keydown=${e => (e.key == "Enter" || e.key == " ") && (e.preventDefault(), toggle())}>
        <img class="zen-library-row-icon" alt=""
             src=${item.type == "audio"
               ? "chrome://browser/skin/zen-icons/selectable/music.svg"
               : "chrome://browser/skin/zen-icons/selectable/video.svg"} />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${item.title}</span>
          <span class="zen-library-row-subtitle">
            ${item.site} ·
            <span data-l10n-id=${STATE_L10N[item.state] ?? STATE_L10N.link}
                  data-l10n-args=${JSON.stringify({ progress: Math.round(item.progress ?? 0) })}></span>
          </span>
        </div>
        <div class="zen-library-row-actions">
          ${item.state == "failed" || item.state == "link"
            ? html`<button class="toolbarbutton-1" data-l10n-id="whimsy-playlist-download"
                @click=${e => (e.stopPropagation(), WhimsyPlaylist.download(item.id))}>
                <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/downloads.svg" alt="" />
              </button>`
            : ""}
          <button class="toolbarbutton-1" data-l10n-id="whimsy-playlist-open-page"
                  @click=${e => (e.stopPropagation(), this.#openPage(item))}>
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/open.svg" alt="" />
          </button>
          <button class="toolbarbutton-1" data-l10n-id="whimsy-playlist-remove"
                  @click=${e => (e.stopPropagation(), WhimsyPlaylist.remove(item.id))}>
            <img class="toolbarbutton-icon" src="chrome://browser/skin/zen-icons/trash.svg" alt="" />
          </button>
        </div>
      </div>
      ${playing ? this.#renderPlayer(item) : ""}
    `;
  }

  render() {
    const items = this.items.filter(item => this.#matches(item));
    if (!items.length) {
      return html`<div class="zen-library-empty" data-l10n-id=${this.items.length
        ? "whimsy-playlist-no-results"
        : "whimsy-playlist-empty"}></div>`;
    }
    return html`<div class="zen-library-group">
      ${repeat(items, item => item.id, item => this.#renderItem(item))}
    </div>`;
  }
}

customElements.define("whimsy-library-playlist-section", WhimsyPlaylistSection);
