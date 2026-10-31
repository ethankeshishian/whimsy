/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6/zap: the zap dust takes the current space's gradient colors.
//
// Runs in the page's process, from one hook in Zen's ZenZapDissolve right
// after it captures the zapped element and before it turns the capture into
// particles. The capture is multiplied with the space's gradient (light parts
// take the color, text and edges stay dark), masked to the element's own
// shape so transparent pixels stay transparent. WhimsyZap shares the colors
// through sharedData, so nothing here talks to the parent.

const FEATURE_PREF = "whimsy.feature.zap";
const TINT_KEY = "whimsy:zap-tint";
const STRENGTH = 0.85;

export const WhimsyZapTint = {
  colors() {
    const colors = Services.cpmm.sharedData.get(TINT_KEY);
    return Array.isArray(colors) ? colors.filter(c => Array.isArray(c) && c.length >= 3) : [];
  },

  tint(ctx, width, height) {
    try {
      if (!ctx || !width || !height || !Services.prefs.getBoolPref(FEATURE_PREF, true)) {
        return false;
      }
      const colors = this.colors();
      if (!colors.length) {
        return false;
      }
      const layer = ctx.canvas.ownerDocument.createElement("canvas");
      layer.width = width;
      layer.height = height;
      const lctx = layer.getContext("2d");
      const gradient = lctx.createLinearGradient(0, 0, width, height);
      const stops = colors.length == 1 ? [colors[0], colors[0]] : colors;
      stops.forEach(([r, g, b], i) => gradient.addColorStop(i / (stops.length - 1), `rgb(${r}, ${g}, ${b})`));
      lctx.fillStyle = gradient;
      lctx.fillRect(0, 0, width, height);
      // Keep the gradient only where the element has pixels.
      lctx.globalCompositeOperation = "destination-in";
      lctx.drawImage(ctx.canvas, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = STRENGTH;
      ctx.drawImage(layer, 0, 0);
      ctx.restore();
      return true;
    } catch (e) {
      console.error("Whimsy: zap tint", e);
      return false;
    }
  },
};
