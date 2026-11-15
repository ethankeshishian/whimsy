/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W29 tab equalizer: a sine tone as a 16-bit mono WAV at 48 kHz.
// ?freq=1000&amp=3277&seconds=10 (amp in 16-bit steps, so every sample is
// an exact k / 32768 once Gecko decodes it).
const RATE = 48000;

function param(query, name, fallback) {
  const match = new RegExp(`(?:^|&)${name}=(\\d+)`).exec(query);
  return match ? parseInt(match[1], 10) : fallback;
}

function handleRequest(request, response) {
  const freq = param(request.queryString, "freq", 1000);
  const amp = Math.min(32767, param(request.queryString, "amp", 3277));
  const seconds = Math.min(30, param(request.queryString, "seconds", 10));
  const frames = RATE * seconds;
  const bytes = [];
  const u32 = v => bytes.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const u16 = v => bytes.push(v & 255, (v >> 8) & 255);
  const ascii = s => bytes.push(...[...s].map(c => c.charCodeAt(0)));
  ascii("RIFF");
  u32(36 + frames * 2);
  ascii("WAVEfmt ");
  u32(16);
  u16(1); // PCM
  u16(1); // mono
  u32(RATE);
  u32(RATE * 2);
  u16(2);
  u16(16);
  ascii("data");
  u32(frames * 2);
  let body = String.fromCharCode(...bytes);
  const chunk = [];
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / RATE)) & 0xffff;
    chunk.push(String.fromCharCode(v & 255, v >> 8));
    if (chunk.length == 4096) {
      body += chunk.join("");
      chunk.length = 0;
    }
  }
  body += chunk.join("");
  response.setHeader("Content-Type", "audio/wav", false);
  response.setHeader("Cache-Control", "max-age=3600", false);
  response.bodyOutputStream.write(body, body.length);
}
