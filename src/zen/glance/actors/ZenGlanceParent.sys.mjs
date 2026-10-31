// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/* eslint-disable consistent-return */

export class ZenGlanceParent extends JSWindowActorParent {
  constructor() {
    super();
  }

  async receiveMessage(message) {
    // Whimsy hotfix: the tab/window may close while an actor message is in flight.
    if (!this.browsingContext.topChromeWindow?.gZenGlanceManager) {
      return;
    }
    switch (message.name) {
      case "ZenGlance:OpenGlance": {
        // Whimsy hotfix: only the URL comes from content; the principal is the
        // parent's own for the page (content or null, never system).
        const url = message.data?.url;
        const principal = this.manager?.documentPrincipal;
        if (
          typeof url !== "string" ||
          !(principal?.isContentPrincipal || principal?.isNullPrincipal)
        ) {
          break;
        }
        this.openGlance(this.browsingContext.topChromeWindow, {
          url,
          triggeringPrincipal: principal,
        });
        break;
      }
      case "ZenGlance:CloseGlance": {
        // Explicitly allowlist fields from content; never forward
        // skipPermitUnload or other privileged flags.
        const { noAnimation, setNewID, hasFocused } = message.data ?? {};
        this.browsingContext.topChromeWindow.gZenGlanceManager.closeGlance({
          onTabClose: true,
          noAnimation: !!noAnimation,
          setNewID: typeof setNewID === "string" ? setNewID : null,
          hasFocused: !!hasFocused,
        });
        break;
      }
      case "ZenGlance:RecordLinkClickData": {
        this.browsingContext.topChromeWindow.gZenGlanceManager.lastLinkClickData =
          message.data;
        break;
      }
      default:
        console.warn(`[glance]: Unknown message: ${message.name}`);
    }
  }

  openGlance(window, data) {
    return window.gZenGlanceManager.openGlance(data);
  }
}
