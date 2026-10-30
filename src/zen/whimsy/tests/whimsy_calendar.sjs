/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// A stand-in for a Google Calendar secret iCal address. Times are relative
// to the `anchor` query parameter (ms since the epoch, the test's "now"),
// so the test knows exactly when everything starts. `?broken` answers 500.

const MIN = 60 * 1000;

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function day(ms) {
  return stamp(ms).slice(0, 8);
}

function handleRequest(request, response) {
  const params = {};
  for (const pair of (request.queryString || "").split("&")) {
    const [key, value = ""] = pair.split("=");
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value);
    }
  }
  if ("broken" in params) {
    response.setStatusLine(request.httpVersion, 500, "Server Error");
    response.write("nope");
    return;
  }
  const now = +params.anchor || Date.now();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
    "BEGIN:VEVENT",
    "UID:review@google.com",
    `DTSTART:${stamp(now + 10 * MIN)}`,
    `DTEND:${stamp(now + 40 * MIN)}`,
    "SUMMARY:Design review",
    "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij",
    "DESCRIPTION:Agenda in the doc\\nJoin with Google Meet: https://meet.google.com/abc-defg-hij",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT10M",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:declined@google.com",
    `DTSTART:${stamp(now + 5 * MIN)}`,
    `DTEND:${stamp(now + 20 * MIN)}`,
    "SUMMARY:Declined sync",
    "ATTENDEE;CN=Me;PARTSTAT=DECLINED:mailto:me@example.com",
    "ATTENDEE;CN=Them;PARTSTAT=ACCEPTED:mailto:them@example.com",
    "LOCATION:https://zoom.us/j/111",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:zoom@google.com",
    `DTSTART:${stamp(now + 180 * MIN)}`,
    `DTEND:${stamp(now + 210 * MIN)}`,
    "SUMMARY:Zoom 1:1",
    "LOCATION:https://us02web.zoom.us/j/123456789?pwd=abc",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:standup@google.com",
    `DTSTART:${stamp(now + 120 * MIN - 3 * 24 * 60 * MIN)}`,
    `DTEND:${stamp(now + 135 * MIN - 3 * 24 * 60 * MIN)}`,
    "RRULE:FREQ=DAILY",
    "SUMMARY:Daily standup",
    "DESCRIPTION:<a href=\"https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0\">Join</a>",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:shared@google.com",
    `DTSTART:${stamp(now + 240 * MIN)}`,
    `DTEND:${stamp(now + 270 * MIN)}`,
    "SUMMARY:Shared meeting",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:allday@google.com",
    `DTSTART;VALUE=DATE:${day(now)}`,
    `DTEND;VALUE=DATE:${day(now + 24 * 60 * MIN)}`,
    "SUMMARY:Holiday",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:over@google.com",
    `DTSTART:${stamp(now - 120 * MIN)}`,
    `DTEND:${stamp(now - 60 * MIN)}`,
    "SUMMARY:Already over",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  response.setHeader("Content-Type", "text/calendar; charset=utf-8", false);
  response.write(lines.join("\r\n") + "\r\n");
}
