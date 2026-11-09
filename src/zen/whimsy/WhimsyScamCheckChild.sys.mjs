/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 page-act: the scam warning's on-device pattern check (spec "Scam
// warning"). No site lists: it only looks at what this page asks for and
// how it talks. Pages without a password or card field are never checked
// further. It reports signals; the parent decides, adds what only the
// browser knows (history), and shows the warning. Nothing the page sets
// can reach the parent except these fixed signal ids and short quotes.

const URGENT_THREAT = /\b(?:within|in(?: the next)?)\s+(?:\d{1,2}|twenty[- ]four|forty[- ]eight)\s+hours?\b[^.]{0,80}\b(?:delet|suspend|lock|clos|terminat|disabl|remov|los)\w*|\b(?:account|access|data)\b[^.]{0,40}\b(?:will be|has been|is)\s+(?:locked|suspended|deleted|disabled|closed|terminated|restricted)\b/i;
const RUSH = /\b(?:only\s+\d{1,3}\s+(?:left|slots?|spots?|items?|seats?|remaining)(?:\s+left)?|act now|hurry|limited time|expires? (?:today|soon|in \d+ (?:minutes|hours))|last chance)\b/i;
const ACCOUNT = /\byour\s+((?:[A-Z][\w&-]{1,20}\s?){1,2})\s+(?:account|ID|password|login|wallet)\b/;
const MAX_TEXT = 20000;

export class WhimsyScamCheckChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type != "pageshow" || event.target != this.document) {
      return;
    }
    const signals = this.check();
    if (signals) {
      this.sendAsyncMessage("WhimsyScamCheck:Signals", signals);
    }
  }

  receiveMessage(message) {
    if (message.name == "WhimsyScamCheck:Check") {
      return this.check();
    }
    return null;
  }

  check() {
    const doc = this.document;
    if (!doc?.body || !/^https?:$/.test(doc.location.protocol)) {
      return null;
    }
    const inputs = [...doc.querySelectorAll("input")];
    const password = inputs.some(el => el.type == "password");
    const card = inputs.some(el => /\bcc-(?:number|csc|exp)/.test(el.getAttribute("autocomplete") ?? "") || /card.?number|\bcvv\b|\bcvc\b/i.test(`${el.name} ${el.id} ${el.placeholder}`));
    if (!password && !card) {
      return null;
    }
    const text = doc.body.innerText.slice(0, MAX_TEXT);
    const host = doc.location.hostname.toLowerCase();
    const signals = [];
    const quote = match => match?.[0]?.replace(/\s+/g, " ").trim().slice(0, 60) ?? "";
    // Names an account that isn't this site's own.
    const account = ACCOUNT.exec(text);
    if (password && account) {
      const name = account[1].trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      if (name.length > 2 && !host.replace(/[^a-z0-9]/g, "").includes(name)) {
        signals.push({ id: "account-elsewhere", quote: account[1].trim() });
      }
    }
    const threat = URGENT_THREAT.exec(text);
    if (threat) {
      signals.push({ id: "threat", quote: quote(threat) });
    }
    const rush = RUSH.exec(text);
    if (rush) {
      signals.push({ id: "rush", quote: quote(rush) });
    }
    const referrer = (() => {
      try {
        return new URL(doc.referrer).hostname;
      } catch {
        return "";
      }
    })();
    if (/(?:^|\.)mail\.|webmail|outlook\.(?:live|office)/i.test(referrer)) {
      signals.push({ id: "from-email" });
    }
    return { host, password, card, signals };
  }
}
