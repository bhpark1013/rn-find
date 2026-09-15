// Pure helpers: turn raw in-app results into an ordered, on-screen list.

/**
 * @param {Array} elements  raw hits from the in-app query
 * @param {{w:number,h:number}} screen  logical screen size in points/dp
 * @param {{all?: boolean}} opts  all=true keeps off-screen and zero-size elements
 */
export function selectElements(elements, screen, { all = false } = {}) {
  return elements
    .filter((e) => all || (e.rect && e.rect.w > 0 && e.rect.h > 0))
    .map((e) => {
      const r = e.rect || { x: 0, y: 0, w: 0, h: 0 };
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      return {
        index: -1,
        i: e.i,
        text: e.text,
        matchedBy: e.matchedBy,
        role: e.role,
        pressable: !!e.pressType,
        pressType: e.pressType,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.w),
        h: Math.round(r.h),
        cx: Math.round(cx),
        cy: Math.round(cy),
        onScreen: cx >= 0 && cx < screen.w && cy >= 0 && cy < screen.h,
      };
    })
    // Off-screen elements (a collapsed bottom sheet, the previous stack screen) overlap
    // nothing the user can see; drop them unless asked.
    .filter((e) => all || e.onScreen)
    // Reading order, so --index means "the Nth one from the top".
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((e, index) => ({ ...e, index }));
}

export function parseScreen(s, fallback = { w: 402, h: 874 }) {
  if (!s) return fallback;
  const m = /^(\d+)x(\d+)$/.exec(s);
  if (!m) throw new Error(`--screen must look like 402x874 (got "${s}")`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

export function formatPlain(elements) {
  return elements
    .map((e) => `${e.index}\t${e.cx},${e.cy}\t${e.role}${e.pressable ? "/press" : ""}\t${JSON.stringify(e.text)}`)
    .join("\n");
}
