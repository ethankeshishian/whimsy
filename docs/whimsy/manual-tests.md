# Manual tests

Checks that need a real site, a real account or a second device, so the
mochitests can't cover them.

## Reject cookie banners

Toggle: Settings → Privacy & Security → Reject cookie banners
(`whimsy.reject-cookie-banners`; the built-in DuckDuckGo Autoconsent add-on).

1. Turn the toggle off, open a site below in a new tab: the consent banner shows.
2. Turn it on, open the site again in a fresh private window (no saved consent):
   the banner is rejected and closes within a second or two.

Sites that show a consent banner (EU sites often show it only to EU
visitors; use Whimsy's VPN with an EU location if it doesn't appear):

- https://stackoverflow.com (OneTrust, shown everywhere)
- https://www.theguardian.com (Sourcepoint)
- https://www.spiegel.de
- https://www.lemonde.fr
- https://elpais.com
- https://www.bbc.co.uk

## Handoff (Mac → iPhone)

On the Mac, open a page in Whimsy (Settings → Privacy & Security → Handoff →
"Continue pages on your iPhone…" on; same Apple Account on both devices,
Bluetooth and Wi-Fi on). On the iPhone, open the App
Switcher: a Safari banner at the bottom shows the page; tap it to open it.
