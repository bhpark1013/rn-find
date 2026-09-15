// Source that runs INSIDE the app (Hermes). Kept as a string so it needs no bundling.
//
// It walks every React fiber root exposed by the React DevTools hook (present in any dev
// build), collects host nodes whose visible text / placeholder / accessibilityLabel / testID
// match a regex, resolves each one's window rect with measureInWindow, and stores the
// result on a global. Fibers are stashed too, so `press` and `type` can call handlers later.
//
// Hermes constraints: no `async`/`await` syntax in evaluated source, and measure callbacks are
// asynchronous, so completion is signalled by writing to the result slot.

export const RESULT_SLOT = "__rnFindResult";
export const HITS_SLOT = "__rnFindHits";

/**
 * @param {object} o
 * @param {string} o.pattern   regex source
 * @param {string} o.flags     regex flags
 * @param {number} o.maxNodes  traversal cap (safety only; whole trees are normally far below it)
 */
export function buildQuerySource({ pattern, flags = "", maxNodes = 1_000_000 }) {
  return `(function () {
  var RESULT = ${JSON.stringify(RESULT_SLOT)}, HITS = ${JSON.stringify(HITS_SLOT)};
  var finish = function (v) { globalThis[RESULT] = v; };
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.renderers || !hook.getFiberRoots) return finish({ error: "React DevTools hook not found: is this a dev build?" });
  var re;
  try { re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)}); }
  catch (e) { return finish({ error: "Bad regex: " + e.message }); }

  // Text children may be a string, a number, or an array of those (e.g. "Total: " + amount).
  var textOf = function (c) {
    if (typeof c === "string" || typeof c === "number") return String(c);
    if (Array.isArray(c) && c.length && c.every(function (t) { return typeof t === "string" || typeof t === "number"; })) return c.join("");
    return null;
  };
  var flatStyle = function (s) {
    if (!s) return {};
    if (Array.isArray(s)) return s.reduce(function (acc, x) { return Object.assign(acc, flatStyle(x)); }, {});
    return typeof s === "object" ? s : {};
  };
  // Navigators keep inactive screens mounted. react-native-screens marks them with
  // activityState/active < 2; treat those and display:none subtrees as invisible.
  // opacity is deliberately ignored: Reanimated drives it natively, so props lie.
  var isHiddenProps = function (p) {
    if (typeof p.activityState === "number" && p.activityState < 2) return true;
    if (typeof p.active === "number" && p.active < 2) return true;
    return flatStyle(p.style).display === "none";
  };
  var nameOf = function (t) { return typeof t === "string" ? t : (t && (t.displayName || t.name)) || "?"; };

  var hits = [], visited = 0, truncated = false;
  hook.renderers.forEach(function (_r, rendererId) {
    hook.getFiberRoots(rendererId).forEach(function (root) {
      var stack = [[root.current, false]];
      while (stack.length) {
        if (visited++ > ${maxNodes}) { truncated = true; return; }
        var entry = stack.pop(), fiber = entry[0], hidden = entry[1];
        var props = fiber.memoizedProps || {};
        hidden = hidden || isHiddenProps(props);
        if (fiber.child) stack.push([fiber.child, hidden]);
        if (fiber.sibling) stack.push([fiber.sibling, entry[1]]);
        if (hidden || typeof fiber.type !== "string") continue;

        var type = fiber.type, text = null, matchedBy = null, role = "view";
        if (/Text$/.test(type)) { text = textOf(props.children); matchedBy = "text"; role = "text"; }
        else if (/TextInput/.test(type)) { role = "input"; text = textOf(props.value) || textOf(props.placeholder) || props.accessibilityLabel || null; matchedBy = props.value != null ? "value" : props.placeholder != null ? "placeholder" : "label"; }
        if (text == null && typeof props.accessibilityLabel === "string") { text = props.accessibilityLabel; matchedBy = "label"; }
        if (text == null && typeof props.testID === "string") { text = props.testID; matchedBy = "testID"; }
        if (text == null || !re.test(text)) continue;

        // Nearest ancestor that handles presses, so "tap the text" lands on the button.
        var handler = fiber;
        while (handler && !(handler.memoizedProps && typeof handler.memoizedProps.onPress === "function")) handler = handler.return;
        hits.push({ fiber: fiber, handler: handler, text: text, matchedBy: matchedBy, role: role, hostType: type, pressType: handler ? nameOf(handler.type) : null });
      }
    });
  });

  globalThis[HITS] = hits;
  var out = [], left = hits.length;
  if (!left) return finish({ visited: visited, truncated: truncated, elements: out });
  hits.forEach(function (h, i) {
    var done = function (rect) {
      out.push({ i: i, text: h.text, matchedBy: h.matchedBy, role: h.role, hostType: h.hostType, pressType: h.pressType, rect: rect });
      if (--left === 0) finish({ visited: visited, truncated: truncated, elements: out });
    };
    try {
      var node = h.fiber.stateNode;
      if (node && typeof node.measureInWindow === "function") node.measureInWindow(function (x, y, w, h2) { done({ x: x, y: y, w: w, h: h2 }); });
      else done(null);
    } catch (e) { done(null); }
  });
  setTimeout(function () { if (globalThis[RESULT] === undefined) finish({ visited: visited, truncated: truncated, elements: out, partial: true }); }, 3000);
})()`;
}

/** Invoke the onPress handler recorded for hit #i, entirely inside the app. */
export function buildPressSource(i) {
  return `(function () {
  var h = (globalThis[${JSON.stringify(HITS_SLOT)}] || [])[${i}];
  if (!h) return "stale";
  if (!h.handler) return "no-handler";
  try { h.handler.memoizedProps.onPress({ nativeEvent: {} }); return "ok"; } catch (e) { return "threw: " + e.message; }
})()`;
}

/** Feed text to a TextInput's onChangeText (and onChange) for hit #i, bypassing the keyboard. */
export function buildTypeSource(i, text) {
  return `(function () {
  var h = (globalThis[${JSON.stringify(HITS_SLOT)}] || [])[${i}];
  if (!h) return "stale";
  var p = h.fiber.memoizedProps || {};
  if (h.role !== "input") return "not-input";
  var t = ${JSON.stringify(text)};
  try {
    // Prefer onChangeText; only fall back to onChange, with a plausible nativeEvent, when the
    // input has no onChangeText. Calling both with a bare event confused handlers that read
    // nativeEvent.target and forwarded it to a UIManager command (RCTLogArgumentError, which
    // also trips the dev-client error overlay). No setNativeProps for the same reason.
    if (typeof p.onChangeText === "function") p.onChangeText(t);
    else if (typeof p.onChange === "function") {
      var node = h.fiber.stateNode || {};
      p.onChange({ nativeEvent: { text: t, eventCount: 0, target: node._nativeTag || node.__nativeTag || null } });
    } else return "no-handler";
    return "ok";
  } catch (e) { return "threw: " + e.message; }
})()`;
}
