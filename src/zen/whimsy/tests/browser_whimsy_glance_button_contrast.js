/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Glance's side buttons (close, expand, split) keep their icons readable
// whatever the space's color: at least 3:1 against the circle, hovered or
// not (W29: a purple space measured 1.7:1).

// Computed colors come back as rgb(0-255) or, after color-mix(),
// color(srgb 0-1).
function luminance(color) {
  const scale = color.startsWith("color(") ? 1 : 255;
  const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
    v /= scale;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

add_task(async function test_icons_contrast_in_any_space_color() {
  const container = document.createElement("div");
  container.className = "zen-glance-sidebar-container";
  const button = document.createXULElement("toolbarbutton");
  // Glance eases its background; read the end value, not the start.
  button.style.transition = "none";
  container.append(button);
  document.getElementById("browser").append(container);
  try {
    for (const scheme of ["light", "dark"]) {
      container.style.colorScheme = scheme;
      for (const primary of ["rgb(87, 38, 182)", "rgb(37, 99, 235)", "rgb(245, 208, 0)", "rgb(250, 250, 250)", "rgb(20, 20, 20)"]) {
        container.style.setProperty("--zen-primary-color", primary);
        const style = getComputedStyle(button);
        const ratio = contrast(style.color, style.backgroundColor);
        Assert.greaterOrEqual(ratio, 3, `${scheme} toolbar, space ${primary}: icon ${style.color} on ${style.backgroundColor} is ${ratio.toFixed(2)}:1`);
        const hover = scheme == "light" ? "rgb(41, 41, 41)" : "rgb(204, 204, 204)";
        Assert.greaterOrEqual(contrast(style.color, hover), 3, `and on the hover circle ${hover}`);
      }
    }
  } finally {
    container.remove();
  }
});
