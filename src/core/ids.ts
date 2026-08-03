/** Короткие устойчивые id узлов. Эти же id становятся якорями data-plx-id в коде. */
export function uid(prefix = "n"): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${rand}`;
}
