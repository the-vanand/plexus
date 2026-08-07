/**
 * ВЫБОР ПАЛИТРЫ (источник: color.romanuke.com — IN COLOR BALANCE).
 *
 * Каждая палитра — 5 подобранных цветов; выбранная палитра ложится на
 * токены темы детерминированным маппингом (см. themes.paletteToColors),
 * который гарантирует читаемость текста независимо от палитры.
 *
 * Наведение — ЖИВОЙ предпросмотр: холст перекрашивается немедленно, но
 * документ не меняется (uiStore.themePreview). Клик — применение через
 * setTheme, то есть обычное действие с undo.
 */
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../core/store";
import { useUi } from "../core/uiStore";
import { hexToHsl, paletteToColors } from "../core/themes";

interface PaletteEntry {
  n: number | null;
  colors: string[];
}

type HueGroup = "all" | "warm" | "green" | "blue" | "violet" | "neutral" | "dark" | "pastel";

const GROUPS: Array<{ id: HueGroup; label: string }> = [
  { id: "all", label: "Все" },
  { id: "warm", label: "Тёплые" },
  { id: "green", label: "Зелёные" },
  { id: "blue", label: "Синие" },
  { id: "violet", label: "Лиловые" },
  { id: "neutral", label: "Нейтральные" },
  { id: "dark", label: "Тёмные" },
  { id: "pastel", label: "Пастель" },
];

/** Группа палитры — по доминирующему тону насыщенных цветов. */
function groupOf(colors: string[]): HueGroup[] {
  const hsl = colors.map(hexToHsl);
  const sat = hsl.filter((c) => c.s > 0.25 && c.l > 0.12 && c.l < 0.9);
  const groups = new Set<HueGroup>();
  if (sat.length <= 1) groups.add("neutral");
  const darks = hsl.filter((c) => c.l < 0.35).length;
  if (darks >= 3) groups.add("dark");
  if (hsl.every((c) => c.l > 0.55) || hsl.filter((c) => c.s < 0.55 && c.l > 0.6).length >= 4) groups.add("pastel");
  for (const c of sat) {
    const h = ((c.h % 360) + 360) % 360;
    /* Границы по восприятию, а не по цветовому кругу поровну: тил и
       бирюза (165-195) для глаза — зелёные, а не синие. */
    if (h < 70 || h >= 330) groups.add("warm");
    else if (h < 195) groups.add("green");
    else if (h < 265) groups.add("blue");
    else groups.add("violet");
  }
  return [...groups];
}

const PAGE = 40;

export function PalettePicker() {
  const theme = useStore((s) => s.doc.theme);
  const setTheme = useStore((s) => s.setTheme);
  const setPreview = useUi((s) => s.setThemePreview);

  const [entries, setEntries] = useState<PaletteEntry[] | null>(null);
  const [group, setGroup] = useState<HueGroup>("all");
  const [shown, setShown] = useState(PAGE);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    void import("../assets/palettes.json").then((m) => {
      if (alive) setEntries((m.default as { palettes: PaletteEntry[] }).palettes);
    });
    return () => {
      alive = false;
    };
  }, []);

  // группы считаются один раз на палитру
  const grouped = useMemo(
    () => (entries ?? []).map((e) => ({ ...e, groups: groupOf(e.colors) })),
    [entries],
  );

  const filtered = useMemo(() => {
    const q = query.trim();
    return grouped.filter((e) => {
      if (group !== "all" && !e.groups.includes(group)) return false;
      if (q && !String(e.n ?? "").startsWith(q)) return false;
      return true;
    });
  }, [grouped, group, query]);

  const current = theme?.palette?.join(",");

  if (!entries) return <div className="side-note">Загрузка палитр…</div>;

  return (
    <div className="palette-picker">
      <div className="field">
        <label>
          Палитры <span className="palette-count">({filtered.length})</span>
        </label>
        <div className="palette-filters">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              className={group === g.id ? "chip on" : "chip"}
              onClick={() => {
                setGroup(g.id);
                setShown(PAGE);
              }}
            >
              {g.label}
            </button>
          ))}
        </div>
        <input
          className="palette-search"
          type="text"
          placeholder="Номер палитры…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setShown(PAGE);
          }}
        />
      </div>

      {theme?.palette && (
        <button
          type="button"
          className="palette-reset"
          onClick={() => setTheme({ palette: undefined })}
        >
          Сбросить палитру (цвета пресета)
        </button>
      )}

      {filtered.length === 0 && (
        <div className="side-note">Палитр не найдено — попробуйте другой номер или группу.</div>
      )}

      <div className="palette-grid" onMouseLeave={() => setPreview(null)}>
        {filtered.slice(0, shown).map((e) => {
          const active = current === e.colors.join(",");
          const mapped = paletteToColors(e.colors);
          return (
            <button
              key={e.n ?? e.colors.join(",")}
              type="button"
              className={active ? "palette-strip on" : "palette-strip"}
              title={`Палитра №${e.n ?? "—"}${mapped ? ` · фон ${mapped.bg}, текст ${mapped.text}, акцент ${mapped.accent}` : ""}`}
              onMouseEnter={() =>
                setPreview({ preset: theme?.preset ?? "minimal", accent: theme?.accent ?? "#aa816a", palette: e.colors })
              }
              onFocus={() =>
                setPreview({ preset: theme?.preset ?? "minimal", accent: theme?.accent ?? "#aa816a", palette: e.colors })
              }
              onBlur={() => setPreview(null)}
              onClick={() => {
                setPreview(null);
                setTheme({ palette: e.colors });
              }}
            >
              {e.colors.map((c) => (
                <span key={c} style={{ background: c }} />
              ))}
              {e.n !== null && <span className="palette-num">№{e.n}</span>}
            </button>
          );
        })}
      </div>

      {shown < filtered.length && (
        <button type="button" className="palette-more" onClick={() => setShown(shown + PAGE)}>
          Показать ещё ({filtered.length - shown})
        </button>
      )}

      <div className="side-note">
        Наведите — предпросмотр на холсте; клик — применить. Источник палитр:{" "}
        <a href="https://color.romanuke.com/" target="_blank" rel="noopener noreferrer">
          color.romanuke.com
        </a>
      </div>
    </div>
  );
}
