// Metro inspector discovery + a minimal Chrome DevTools Protocol session against Hermes.
//
// A React Native dev build registers its Hermes runtime with Metro, which lists it at
// `<metro>/json` (same shape as Chrome's /json). We open the WebSocket it advertises and
// issue Runtime.evaluate. Hermes accepts one debugger client at a time, so every session
// is short-lived: connect, evaluate, close.

export class RnFindError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const REANIMATED = /reanimated/i;

/** List Hermes JS runtimes Metro knows about (one per connected app), excluding Reanimated's UI runtime. */
export async function listTargets(metroUrl) {
  let pages;
  try {
    const res = await fetch(`${metroUrl}/json`, { signal: AbortSignal.timeout(5000) });
    pages = await res.json();
  } catch (e) {
    throw new RnFindError(`Cannot reach Metro inspector at ${metroUrl}/json (${e.message}). Is Metro running?`, 3);
  }
  return pages
    .filter((p) => p.webSocketDebuggerUrl && !REANIMATED.test(`${p.title} ${p.description}`))
    .map((p) => ({
      id: p.id,
      title: p.title || "",
      description: p.description || "",
      deviceName: (p.title.match(/\(([^)]+)\)\s*$/) || [])[1] || "",
      wsUrl: p.webSocketDebuggerUrl,
    }));
}

/** Pick a target: by device-name substring if given, else the first one. */
export function chooseTarget(targets, deviceHint) {
  if (!targets.length) throw new RnFindError("No app connected to Metro. Launch the dev build first.", 3);
  if (!deviceHint) return targets[0];
  const hit = targets.find((t) => t.title.includes(deviceHint) || t.deviceName.includes(deviceHint));
  if (!hit) {
    const names = targets.map((t) => t.deviceName || t.title).join(", ");
    throw new RnFindError(`No Metro target matches "${deviceHint}". Connected: ${names}`, 3);
  }
  return hit;
}

/** Open a CDP session. Returns { evaluate(expr) → value, close() }. */
export async function openSession(target) {
  const ws = new WebSocket(target.wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new RnFindError(`WebSocket to ${target.wsUrl} failed (another debugger attached?)`, 3));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    async evaluate(expression) {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true });
      const ex = r.result?.exceptionDetails;
      if (ex) throw new RnFindError(`In-app evaluation threw: ${ex.exception?.description || ex.text}`);
      return r.result?.result?.value;
    },
    /**
     * Hermes cannot evaluate `async` source and RN swaps Promise for a polyfill CDP can't await,
     * so async work in the app writes its result to a global and we poll for it.
     */
    async evaluateAsync(slot, expression, { timeoutMs = 4000 } = {}) {
      await this.evaluate(`globalThis[${JSON.stringify(slot)}] = undefined`);
      await this.evaluate(expression);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((t) => setTimeout(t, 50));
        const raw = await this.evaluate(`JSON.stringify(globalThis[${JSON.stringify(slot)}] ?? null)`);
        if (raw && raw !== "null") return JSON.parse(raw);
      }
      throw new RnFindError("Timed out waiting for the in-app query to finish");
    },
    close() {
      ws.close();
    },
  };
}
