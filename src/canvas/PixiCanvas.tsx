/**
 * React-обёртка холста: поднимает Pixi Application, связывает
 * решатель раскладки ⇄ рендерер ⇄ контроллер взаимодействий ⇄ стор,
 * хостит контекстное меню и подсказку пустого холста.
 */
import { useEffect, useRef, useState } from "react";
import { Application } from "pixi.js";
import { computeLayout } from "../core/layout";
import { useStore } from "../core/store";
import type { Rect, SceneDocument } from "../core/types";
import { INSERT_PRESETS, WIRE_ACTION_LABELS, resolveDocAt } from "../core/scene";
import { clearMeasureCache, measureText } from "./measure";
import { ensureThemeFonts, resolveTheme } from "../core/themes";
import { useUi } from "../core/uiStore";
import { CanvasRenderer, setTextureInvalidator } from "./renderer";
import {
  InteractionController,
  canAcceptChildren,
  type ContextMenuRequest,
  type WireCutRequest,
  type WireMenuRequest,
} from "./interactions";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { TextToolbar } from "../components/TextToolbar";

interface ToolbarPos {
  id: string;
  x: number;
  y: number;
}

export function PixiCanvas({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<ContextMenuRequest | null>(null);
  const [wireMenu, setWireMenu] = useState<WireMenuRequest | null>(null);
  const [wireCut, setWireCut] = useState<WireCutRequest | null>(null);
  const [toolbar, setToolbar] = useState<ToolbarPos | null>(null);
  const toolbarRef = useRef<ToolbarPos | null>(null);
  const isEmpty = useStore((s) => s.doc.rootFrames.length === 0);
  const eyeMode = useStore((s) => s.eyeMode);

  useEffect(() => {
    const host = hostRef.current!;
    let disposed = false;
    let app: Application | null = null;
    let controller: InteractionController | null = null;
    let unsub: () => void = () => {};
    let raf = 0;

    (async () => {
      const pixi = new Application();
      await pixi.init({
        background: CanvasRenderer.backgroundColor,
        resizeTo: host,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
      if (disposed) {
        pixi.destroy(true);
        return;
      }
      app = pixi;
      host.appendChild(pixi.canvas);

      const renderer = new CanvasRenderer(pixi);
      let rects: Map<string, Rect> = new Map();
      /**
       * Документ, который РИСУЕТСЯ. При активном брейкпоинте он отличается от
       * того, что лежит в сторе: узлы несут разрешённые значения, скрытые
       * выброшены из дерева. Рисовать базовый документ с геометрией
       * брейкпоинта нельзя — кегли и выравнивание разошлись бы с раскладкой.
       * Правки по-прежнему уходят в настоящий документ через действия стора.
       */
      let view: SceneDocument = useStore.getState().doc;

      const computeRects = (): void => {
        const s = useStore.getState();
        const bpId = useUi.getState().activeBreakpoint;
        const bp = bpId ? s.doc.breakpoints.find((b) => b.id === bpId) : undefined;
        view = bpId ? resolveDocAt(s.doc, bpId) : s.doc;
        rects = computeLayout(
          s.doc,
          measureText,
          bpId ? { width: bp?.maxWidth, breakpointId: bpId } : undefined,
        );
        // высоты содержимого страниц — для кнопки «Подогнать под содержимое»
        const map: Record<string, number> = {};
        for (const fid of s.doc.rootFrames) {
          const r = rects.get(fid);
          if (r) map[fid] = r.h;
        }
        (window as unknown as { __plxFrameContentH?: Record<string, number> }).__plxFrameContentH = map;
        // фактические прямоугольники всех узлов — для кнопок выравнивания в инспекторе
        (window as unknown as { __plxRects?: typeof rects }).__plxRects = rects;
      };

      const draw = (): void => {
        raf = 0;
        const s = useStore.getState();
        const c = controller!;
        renderer.render({
          doc: view,
          rects,
          camera: c.camera,
          selection: s.selection,
          hoverId: s.hoverId,
          guides: c.guides,
          badges: c.badges,
          insertion: c.insertion,
          dragOutline: c.dragOutline,
          marquee: c.marquee,
          gridShow: useUi.getState().gridShow,
          eyeMode: s.eyeMode,
          wireDrag: c.wireDrag,
          wireTargetId: c.wireTargetId,
          screenW: host.clientWidth,
          screenH: host.clientHeight,
        });

        /* позиция плавающей панели форматирования текста */
        let next: ToolbarPos | null = null;
        const selId = s.selection.length === 1 ? s.selection[0] : null;
        const selNode = selId ? s.doc.nodes[selId] : null;
        if (selId && selNode && !s.eyeMode && (selNode.type === "text" || selNode.type === "button")) {
          const r = rects.get(selId);
          if (r) {
            const sx = (r.x + r.w / 2 - c.camera.x) * c.camera.zoom;
            const sy = (r.y - c.camera.y) * c.camera.zoom;
            next = { id: selId, x: Math.round(sx), y: Math.round(Math.max(8, sy - 52)) };
          }
        }
        const prev = toolbarRef.current;
        if (
          (prev === null) !== (next === null) ||
          (prev && next && (prev.id !== next.id || prev.x !== next.x || prev.y !== next.y))
        ) {
          toolbarRef.current = next;
          setToolbar(next);
        }
      };
      const scheduleDraw = (): void => {
        if (!raf) raf = requestAnimationFrame(draw);
      };
      setTextureInvalidator(scheduleDraw);

      computeRects();
      controller = new InteractionController(pixi.canvas, {
        getRects: () => rects,
        requestRender: scheduleDraw,
        openContextMenu: setMenu,
        openWireMenu: setWireMenu,
        openWireCut: setWireCut,
        onZoomChange,
      });
      controller.fitToContent(host.clientWidth, host.clientHeight);

      /* шрифты темы: подгружаем и пересчитываем раскладку после загрузки.
         Пока webfont не готов, метрика считается по системному шрифту —
         поэтому обязательно перезамеряем и на loadingdone, и на fonts.ready
         (иначе текст «съезжает» на первых кадрах). */
      ensureThemeFonts(resolveTheme(useStore.getState().doc.theme));
      const onFontsLoaded = (): void => {
        clearMeasureCache();
        computeRects();
        scheduleDraw();
      };
      document.fonts.addEventListener("loadingdone", onFontsLoaded);
      void document.fonts.ready.then(onFontsLoaded);

      /* документ изменился → пересчёт раскладки; всё остальное → перерисовка */
      let lastRev = useStore.getState().rev;
      let lastFocus = useStore.getState().focusNonce;
      let lastThemeKey = JSON.stringify(useStore.getState().doc.theme);
      unsub = useStore.subscribe((s) => {
        if (s.rev !== lastRev) {
          lastRev = s.rev;
          const themeKey = JSON.stringify(s.doc.theme);
          if (themeKey !== lastThemeKey) {
            lastThemeKey = themeKey;
            ensureThemeFonts(resolveTheme(s.doc.theme));
            clearMeasureCache();
          }
          computeRects();
        }
        if (s.focusNonce !== lastFocus) {
          lastFocus = s.focusNonce;
          if (s.focusTargetId) {
            computeRects();
            controller!.focusOn(s.focusTargetId);
          }
        }
        scheduleDraw();
      });
      /* Переключатели интерфейса (сетка и пр.) тоже перерисовывают холст.
         Но смена брейкпоинта — не косметика: меняется сама раскладка,
         поэтому одной перерисовки недостаточно, нужен пересчёт. */
      let lastBp = useUi.getState().activeBreakpoint;
      const unsubUi = useUi.subscribe((u) => {
        if (u.activeBreakpoint !== lastBp) {
          lastBp = u.activeBreakpoint;
          computeRects();
        }
        scheduleDraw();
      });

      /* ВАЖНО: Pixi resizeTo слушает только resize окна — при сворачивании
         панелей контейнер меняется без события. ResizeObserver чинит
         «маленькое окно работы» при скрытых панелях. */
      const ro = new ResizeObserver(() => {
        pixi.resize();
        scheduleDraw();
      });
      ro.observe(host);

      const unsubFonts = (): void => document.fonts.removeEventListener("loadingdone", onFontsLoaded);
      const prevUnsub = unsub;
      unsub = () => {
        prevUnsub();
        unsubUi();
        unsubFonts();
        ro.disconnect();
      };

      draw();
    })();

    return () => {
      disposed = true;
      unsub();
      if (raf) cancelAnimationFrame(raf);
      controller?.destroy();
      app?.destroy(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- контекстное меню ---------------- */

  const menuItems: MenuItem[] = [];
  if (menu) {
    const store = useStore.getState();
    const close = (): void => setMenu(null);

    if (menu.targetId && canAcceptChildren(menu.targetId)) {
      const targetName = store.doc.nodes[menu.targetId]?.name ?? "";
      for (const preset of INSERT_PRESETS) {
        menuItems.push({
          label: `Добавить: ${preset.label.toLowerCase()}`,
          hint: `→ ${targetName}`,
          action: () => {
            store.addNode(preset.type, menu.targetId!, undefined, preset.init);
            close();
          },
        });
      }
      menuItems.push("sep");
    } else if (menu.targetId) {
      const parentId = store.doc.nodes[menu.targetId]?.parent;
      if (parentId) {
        const parentName = store.doc.nodes[parentId]?.name ?? "";
        for (const preset of INSERT_PRESETS) {
          menuItems.push({
            label: `Добавить рядом: ${preset.label.toLowerCase()}`,
            hint: `→ ${parentName}`,
            action: () => {
              store.addNode(preset.type, parentId, undefined, preset.init);
              close();
            },
          });
        }
        menuItems.push("sep");
      }
    }

    if (menu.targetId) {
      const targetNode = store.doc.nodes[menu.targetId];
      if (targetNode && targetNode.type !== "frame" && targetNode.type !== "instance") {
        menuItems.push({
          label: "Создать компонент",
          hint: "⟐",
          action: () => {
            store.createComponent(menu.targetId!);
            close();
          },
        });
      }
      menuItems.push({
        label: "Дублировать",
        hint: "Ctrl+D",
        action: () => {
          store.duplicateNodes([menu.targetId!]);
          close();
        },
      });
      menuItems.push({
        label: "Удалить",
        hint: "Del",
        danger: true,
        action: () => {
          store.removeNodes([menu.targetId!]);
          close();
        },
      });
    } else {
      menuItems.push({
        label: "Новый фрейм здесь",
        action: () => {
          store.addFrameAt(menu.worldX, menu.worldY);
          close();
        },
      });
    }
  }

  /* ---------------- меню выбора действия провода ---------------- */

  const wireItems: MenuItem[] = [];
  if (wireMenu) {
    const store = useStore.getState();
    const target = store.doc.nodes[wireMenu.targetId];
    const closeWire = (): void => setWireMenu(null);
    if (target) {
      if (target.type === "frame") {
        wireItems.push({
          label: `→ Перейти на «${target.name}»`,
          action: () => {
            store.addWire(wireMenu.sourceId, wireMenu.targetId, "navigate");
            closeWire();
          },
        });
      } else {
        wireItems.push({
          label: `Показать/скрыть «${target.name}»`,
          action: () => {
            store.addWire(wireMenu.sourceId, wireMenu.targetId, "toggle");
            closeWire();
          },
        });
        if (target.type === "container") {
          wireItems.push({
            label: `⇪ Отправить поля «${target.name}» в бэкенд`,
            action: () => {
              store.addWire(wireMenu.sourceId, wireMenu.targetId, "submit");
              closeWire();
            },
          });
        }
      }
    }
  }

  return (
    <div className="canvas-host" ref={hostRef}>
      {isEmpty && (
        <div className="empty-hint">
          <div className="empty-hint-title">Пустой холст</div>
          <div>Правый клик → «Новый фрейм здесь», чтобы начать.</div>
        </div>
      )}
      {eyeMode && (
        <div className="eye-banner">
          Режим проводов: тяни от <span className="dot-sky">●</span> выхода элемента к цели · Esc — выйти
        </div>
      )}
      {toolbar && <TextToolbar nodeId={toolbar.id} x={toolbar.x} y={toolbar.y} />}
      {menu && (
        <ContextMenu x={menu.screenX} y={menu.screenY} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {wireMenu && wireItems.length > 0 && (
        <ContextMenu
          x={wireMenu.screenX}
          y={wireMenu.screenY}
          items={wireItems}
          onClose={() => setWireMenu(null)}
        />
      )}
      {wireCut && (
        <ContextMenu
          x={wireCut.screenX}
          y={wireCut.screenY}
          items={(() => {
            const store = useStore.getState();
            const wire = store.doc.wires.find((w) => w.id === wireCut.wireId);
            const label = wire
              ? `${store.doc.nodes[wire.sourceId]?.name ?? "?"} → ${store.doc.nodes[wire.targetId]?.name ?? "?"} (${(WIRE_ACTION_LABELS[wire.action] ?? "").toLowerCase()})`
              : "";
            return [
              {
                label: `✂ Разрезать связь`,
                hint: label,
                danger: true,
                action: () => {
                  store.removeWire(wireCut.wireId);
                  setWireCut(null);
                },
              },
            ] as MenuItem[];
          })()}
          onClose={() => setWireCut(null)}
        />
      )}
    </div>
  );
}
