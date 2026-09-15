import { parseArgs } from "node:util";
import { listTargets, chooseTarget, openSession, RnFindError } from "./inspector.js";
import { buildQuerySource, buildPressSource, buildTypeSource, RESULT_SLOT } from "./query.js";
import { selectElements, parseScreen, formatPlain } from "./select.js";
import { makeDriver, resolveIosDevice, resolveAndroidDevice } from "./device.js";

const USAGE = `rn-find — find and tap React Native elements by text via Metro's Hermes inspector

Usage
  rn-find find    <regex>            list matching on-screen elements
  rn-find tap     <regex>            tap the match with a real touch (idb / adb)
  rn-find press   <regex>            call the match's onPress inside the app (no touch)
  rn-find type    <regex> <text>     feed text to a TextInput via onChangeText (--native types with the keyboard)
  rn-find wait    <regex>            poll until a match is on screen
  rn-find targets                    list apps connected to Metro

Options
  --metro <url>       Metro URL (default $RN_METRO_URL or http://localhost:8081)
  --device <id>       simulator name/UDID, adb serial, or Metro target name ($RN_DEVICE)
  --platform ios|android   default ios
  --index <n>         which match, in reading order (default 0)
  --all               include off-screen / zero-size matches
  --screen <WxH>      logical screen size for the on-screen test (default 402x874)
  --flags <f>         regex flags, e.g. i
  --timeout <ms>      for wait (default 15000)
  --json              machine-readable output (default for find)
  --plain             one line per match: index, center, role, text
  --native            type: use the platform keyboard instead of onChangeText

Exit codes: 0 ok · 1 not found / usage · 3 Metro or app unreachable · 4 device tool failed`;

export async function main(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      metro: { type: "string" },
      device: { type: "string" },
      platform: { type: "string", default: "ios" },
      index: { type: "string", default: "0" },
      all: { type: "boolean", default: false },
      screen: { type: "string" },
      flags: { type: "string", default: "" },
      timeout: { type: "string", default: "15000" },
      json: { type: "boolean", default: false },
      plain: { type: "boolean", default: false },
      native: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, pattern, extra] = positionals;
  if (o.help || !cmd) {
    console.log(USAGE);
    return o.help ? 0 : 1;
  }
  const metro = (o.metro || process.env.RN_METRO_URL || "http://localhost:8081").replace(/\/$/, "");
  const deviceOpt = o.device || process.env.RN_DEVICE;
  const screen = parseScreen(o.screen);
  const index = Number(o.index);

  const targets = await listTargets(metro);
  if (cmd === "targets") {
    console.log(JSON.stringify(targets.map(({ title, deviceName }) => ({ title, deviceName })), null, 2));
    return 0;
  }
  if (!pattern) throw new RnFindError(`"${cmd}" needs a <regex>\n\n${USAGE}`);
  if (!["find", "tap", "press", "type", "wait"].includes(cmd)) throw new RnFindError(`Unknown command "${cmd}"\n\n${USAGE}`);

  // A device hint that is not a UDID/serial may name the Metro target ("iPhone 17").
  const targetHint = deviceOpt && !/^[0-9A-F-]{36}$/i.test(deviceOpt) ? deviceOpt : undefined;
  const target = chooseTarget(targets, targetHint);

  const query = async (session) => {
    const raw = await session.evaluateAsync(RESULT_SLOT, buildQuerySource({ pattern, flags: o.flags }));
    if (raw.error) throw new RnFindError(raw.error);
    return { ...raw, elements: selectElements(raw.elements, screen, { all: o.all || cmd === "press" || cmd === "type" }) };
  };

  if (cmd === "wait") {
    const deadline = Date.now() + Number(o.timeout);
    const started = Date.now();
    for (;;) {
      const session = await openSession(target);
      let res;
      try { res = await query(session); } finally { session.close(); }
      if (res.elements.length) {
        emit(o, { waitedMs: Date.now() - started, target: target.title, elements: res.elements });
        return 0;
      }
      if (Date.now() > deadline) throw new RnFindError(`Timed out after ${o.timeout}ms waiting for /${pattern}/`);
      await new Promise((t) => setTimeout(t, 400));
    }
  }

  const session = await openSession(target);
  try {
    const res = await query(session);
    if (cmd === "find") {
      emit({ ...o, json: !o.plain }, { target: target.title, visited: res.visited, truncated: res.truncated, elements: res.elements });
      return res.elements.length ? 0 : 1;
    }
    // `type` wants an input; if the regex also matched plain text (a label next to the field,
    // a description that happens to contain the placeholder), prefer the inputs.
    const pool = cmd === "type" && res.elements.some((e) => e.role === "input") ? res.elements.filter((e) => e.role === "input") : res.elements;
    const hit = pool[index];
    if (!hit) throw new RnFindError(`No on-screen match #${index} for /${pattern}/ (${res.elements.length} match${res.elements.length === 1 ? "" : "es"}). Try \`rn-find find\` or --all.`);

    if (cmd === "press") {
      if (!hit.pressable) throw new RnFindError(`"${hit.text}" has no onPress ancestor; use \`tap\` for a native touch.`);
      const r = await session.evaluate(buildPressSource(hit.i));
      if (r !== "ok") throw new RnFindError(`press failed: ${r}`);
      emit(o, { pressed: hit.text, via: hit.pressType, element: hit });
      return 0;
    }
    if (cmd === "type" && !o.native) {
      if (extra == null) throw new RnFindError("type needs <text>");
      const r = await session.evaluate(buildTypeSource(hit.i, extra));
      if (r !== "ok") throw new RnFindError(`type failed: ${r}`);
      emit(o, { typed: extra, into: hit.text, element: hit });
      return 0;
    }

    // Native input: tap, or type with --native.
    const deviceId = o.platform === "android" ? await resolveAndroidDevice(deviceOpt) : await resolveIosDevice(deviceOpt, target);
    const driver = makeDriver(o.platform, deviceId);
    if (cmd === "tap") {
      await driver.tap(hit.cx, hit.cy);
      emit(o, { tapped: [hit.cx, hit.cy], device: deviceId, element: hit, candidates: res.elements.length });
      return 0;
    }
    if (extra == null) throw new RnFindError("type needs <text>");
    await driver.tap(hit.cx, hit.cy);
    await driver.typeNative(extra);
    emit(o, { typed: extra, into: hit.text, device: deviceId, native: true });
    return 0;
  } finally {
    session.close();
  }
}

function emit(o, payload) {
  if (o.plain && payload.elements) return console.log(formatPlain(payload.elements));
  if (o.json || payload.elements) return console.log(JSON.stringify(payload, null, o.json ? 0 : 1));
  const line = payload.tapped ? `tapped "${payload.element.text}" at ${payload.tapped.join(",")}`
    : payload.pressed ? `pressed "${payload.pressed}" via ${payload.via}`
    : "typed" in payload ? `typed ${JSON.stringify(payload.typed)} into "${payload.into}"`
    : JSON.stringify(payload);
  console.log(line);
}
