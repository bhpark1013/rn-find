// Native input backends. rn-find computes coordinates from the React tree; something else has
// to deliver the touch. iOS simulators use idb (facebook/idb); Android uses adb.
import { execFile } from "node:child_process";
import { RnFindError } from "./inspector.js";

const exec = (file, args, timeout = 30_000) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === "ENOENT") return reject(new RnFindError(`"${file}" not found on PATH. ${INSTALL_HINT[file] || ""}`.trim(), 4));
        return reject(new RnFindError(`${file} ${args.join(" ")} failed: ${(stderr || err.message).trim()}`, 4));
      }
      resolve(stdout);
    }),
  );

const INSTALL_HINT = {
  idb: "Install with: brew tap facebook/fb && brew install idb-companion && pipx install fb-idb",
  adb: "Install Android platform-tools and put adb on PATH.",
  xcrun: "Install Xcode command line tools.",
};

/** Booted iOS simulators as [{ name, udid }]. */
export async function bootedSimulators() {
  const out = await exec("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  const devices = JSON.parse(out).devices || {};
  return Object.values(devices).flat().map((d) => ({ name: d.name, udid: d.udid }));
}

/**
 * Resolve which simulator to drive. Priority: explicit UDID → explicit name → the booted
 * simulator whose name appears in the Metro target's title → the only booted one.
 */
export async function resolveIosDevice(explicit, target) {
  if (explicit && /^[0-9A-F-]{36}$/i.test(explicit)) return explicit;
  const sims = await bootedSimulators();
  if (!sims.length) throw new RnFindError("No booted iOS simulator.", 4);
  const byName = (n) => sims.find((s) => s.name === n) || sims.find((s) => s.name.includes(n));
  const hit = (explicit && byName(explicit)) || (target?.deviceName && byName(target.deviceName)) || (sims.length === 1 ? sims[0] : null);
  if (!hit) {
    throw new RnFindError(`Several simulators are booted (${sims.map((s) => s.name).join(", ")}); pass --device <name|udid>.`, 4);
  }
  return hit.udid;
}

export async function resolveAndroidDevice(explicit) {
  if (explicit) return explicit;
  const out = await exec("adb", ["devices"]);
  const serials = out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]);
  if (serials.length !== 1) throw new RnFindError(`Expected exactly one adb device, found ${serials.length}; pass --device <serial>.`, 4);
  return serials[0];
}

export function makeDriver(platform, deviceId) {
  if (platform === "android") {
    let scale = null;
    const dpToPx = async (v) => {
      if (scale == null) {
        const out = await exec("adb", ["-s", deviceId, "shell", "wm", "density"]);
        const dpi = Number((/(\d+)\s*$/.exec(out.split("\n").find((l) => l.includes("density")) || "") || [])[1] || 160);
        scale = dpi / 160;
      }
      return Math.round(v * scale);
    };
    return {
      platform,
      deviceId,
      async tap(x, y) {
        await exec("adb", ["-s", deviceId, "shell", "input", "tap", String(await dpToPx(x)), String(await dpToPx(y))]);
      },
      async swipe(x1, y1, x2, y2, ms = 300) {
        await exec("adb", ["-s", deviceId, "shell", "input", "swipe", ...(await Promise.all([x1, y1, x2, y2].map(dpToPx))).map(String), String(ms)]);
      },
      async typeNative(text) {
        await exec("adb", ["-s", deviceId, "shell", "input", "text", text.replace(/ /g, "%s")]);
      },
    };
  }
  return {
    platform: "ios",
    deviceId,
    async tap(x, y) {
      await exec("idb", ["ui", "tap", "--udid", deviceId, String(x), String(y)]);
    },
    async swipe(x1, y1, x2, y2, ms = 300) {
      await exec("idb", ["ui", "swipe", "--udid", deviceId, "--duration", String(ms / 1000), String(x1), String(y1), String(x2), String(y2)]);
    },
    async typeNative(text) {
      if (/[^\x20-\x7e]/.test(text)) throw new RnFindError("idb can only type ASCII natively; drop --native to feed onChangeText directly.", 4);
      await exec("idb", ["ui", "text", "--udid", deviceId, text]);
    },
  };
}
