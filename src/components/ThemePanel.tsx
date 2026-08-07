/**
 * Блок «Стиль сайта»: пресет + акцентный цвет + палитра (окно настроек
 * проекта). Свотчи показывают то, что видит холст: при наведении на
 * палитру — предпросмотр, иначе — тему документа. Цвета вычисляются
 * детерминированно (см. core/themes.ts), результат воспроизводим.
 */
import { useStore } from "../core/store";
import { useUi } from "../core/uiStore";
import { PRESETS, PRESET_IDS, resolveTheme, type PresetId } from "../core/themes";
import { PalettePicker } from "./PalettePicker";

export function ThemePanel() {
  const theme = useStore((s) => s.doc.theme);
  const setTheme = useStore((s) => s.setTheme);
  const preview = useUi((s) => s.themePreview);
  const resolved = resolveTheme(preview ?? theme);

  const swatches: Array<[string, string]> = [
    ["Фон", resolved.colors.bg],
    ["Поверхность", resolved.colors.surface],
    ["Текст", resolved.colors.text],
    ["Приглушённый", resolved.colors.muted],
    ["Акцент", resolved.colors.accent],
  ];

  return (
    <div className="theme-panel">
      <div className="field">
        <label>Стиль</label>
        <select
          value={theme?.preset ?? "minimal"}
          onChange={(e) => setTheme({ preset: e.target.value as PresetId })}
        >
          {PRESET_IDS.map((id) => (
            <option key={id} value={id}>
              {PRESETS[id].label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Акцентный цвет</label>
        <div className="color-control">
          <input
            type="color"
            value={theme?.accent ?? "#aa816a"}
            onChange={(e) => setTheme({ accent: e.target.value })}
          />
          <span className="color-hex">{theme?.accent}</span>
        </div>
      </div>
      <div className="theme-swatches">
        {swatches.map(([label, color]) => (
          <span key={label} className="theme-swatch" title={`${label}: ${color}`} style={{ background: color }} />
        ))}
        {theme?.palette && <span className="side-note">палитра активна</span>}
      </div>
      <div className="side-note">
        Шрифты: {resolved.fonts.heading.split(",")[0].replace(/'/g, "")} +{" "}
        {resolved.fonts.body.split(",")[0].replace(/'/g, "")}
      </div>

      <PalettePicker />
    </div>
  );
}
