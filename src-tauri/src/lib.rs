//! Rust-часть Plexus: команды, которые фронтенд вызывает через invoke().
//!
//! Здесь живёт всё «настоящее»: файловая система, запуск команд терминала.
//! Каждая команда — async и уводит блокирующую работу в пул потоков,
//! чтобы UI-поток окна никогда не замирал.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// Реестр живых процессов терминала: id → Child (для kill).
pub struct ProcRegistry(Mutex<HashMap<u64, std::process::Child>>);

static NEXT_PROC_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
struct TermChunk {
    id: u64,
    kind: String, // out | err | exit
    line: String,
}

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub struct CmdOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Домашняя папка пользователя — стартовая точка при выборе папки проекта.
#[tauri::command]
async fn home_dir() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "домашняя папка не найдена".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Корень проекта. В dev cwd указывает на src-tauri — поднимаемся на уровень выше.
#[tauri::command]
async fn project_root() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut dir = std::env::current_dir().map_err(|e| e.to_string())?;
        if dir.ends_with("src-tauri") {
            dir.pop();
        }
        Ok(dir.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Список записей каталога: папки первыми, затем файлы, всё по алфавиту.
#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries: Vec<FsEntry> = std::fs::read_dir(&path)
            .map_err(|e| format!("{path}: {e}"))?
            .filter_map(|entry| entry.ok())
            .map(|entry| {
                let p: PathBuf = entry.path();
                FsEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: p.to_string_lossy().to_string(),
                    is_dir: p.is_dir(),
                }
            })
            // скрываем служебные каталоги, чтобы дерево оставалось читаемым
            .filter(|e| !matches!(e.name.as_str(), "node_modules" | "target" | ".git" | "dist"))
            .collect();
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Запись файла с автосозданием родительских папок —
/// именно так «действия на холсте создают папки проекта».
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = Path::new(&path).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Выполнение команды терминала (git status, npm install, …).
/// v0.1 — блокирующий запуск с полным выводом по завершении;
/// стриминговый PTY (portable-pty) — в дорожной карте.
#[tauri::command]
async fn run_command(command: String, cwd: Option<String>) -> Result<CmdOutput, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let mut cmd = {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", &command]);
            c
        };
        #[cfg(not(target_os = "windows"))]
        let mut cmd = {
            let mut c = std::process::Command::new("sh");
            c.args(["-lc", &command]);
            c
        };

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let output = cmd.output().map_err(|e| e.to_string())?;
        Ok(CmdOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Скачать текст по URL (импорт сайта по ссылке).
/// HTTP-клиент на стороне Rust обходит CORS webview; логику разбора
/// HTML/CSS делает фронтенд (там есть DOMParser).
#[tauri::command]
async fn fetch_url(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resp = ureq::get(&url)
            .set("User-Agent", "PlexusImporter/0.7 (+https://plexus.studio)")
            .timeout(std::time::Duration::from_secs(20))
            .call()
            .map_err(|e| e.to_string())?;
        resp.into_string().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Копирование картинки пользователя в assets сайта.
/// Возвращает относительный путь "assets/имя.ext" для node.src.
#[tauri::command]
async fn copy_into_assets(src: String, project_root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = PathBuf::from(&src);
        let file_name = source
            .file_name()
            .ok_or("некорректный файл")?
            .to_string_lossy()
            .to_string();
        let assets_dir = Path::new(&project_root).join("site").join("assets");
        std::fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
        // дедупликация имени
        let mut dest = assets_dir.join(&file_name);
        let mut counter = 1u32;
        while dest.exists() {
            let stem = source.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let ext = source.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
            dest = assets_dir.join(format!("{stem}-{counter}{ext}"));
            counter += 1;
        }
        std::fs::copy(&source, &dest).map_err(|e| e.to_string())?;
        Ok(format!("assets/{}", dest.file_name().unwrap().to_string_lossy()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Стриминговый запуск команды: stdout/stderr уходят событиями plx://term
/// построчно, завершение — событием kind="exit" с кодом выхода.
/// v1 без интерактивного stdin; полноценный PTY — в дорожной карте.
#[tauri::command]
fn start_command(
    app: AppHandle,
    registry: State<'_, ProcRegistry>,
    command: String,
    cwd: Option<String>,
) -> Result<u64, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", &command]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = std::process::Command::new("sh");
        c.args(["-lc", &command]);
        c
    };

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.stdin(std::process::Stdio::null());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let id = NEXT_PROC_ID.fetch_add(1, Ordering::SeqCst);

    // читатели пайпов: каждая строка — событие в webview
    let spawn_reader = |app: AppHandle, id: u64, kind: &'static str, pipe: Box<dyn std::io::Read + Send>| {
        std::thread::spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app.emit("plx://term", TermChunk { id, kind: kind.into(), line });
            }
        });
    };
    if let Some(out) = child.stdout.take() {
        spawn_reader(app.clone(), id, "out", Box::new(out));
    }
    if let Some(err) = child.stderr.take() {
        spawn_reader(app.clone(), id, "err", Box::new(err));
    }

    registry.0.lock().unwrap().insert(id, child);

    // монитор завершения: try_wait + событие exit
    // (реестр — managed state, живёт весь срок приложения; берём через app)
    let monitor_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let state: State<ProcRegistry> = monitor_app.state();
        let mut map = state.0.lock().unwrap();
        match map.get_mut(&id).map(|c| c.try_wait()) {
            Some(Ok(Some(status))) => {
                map.remove(&id);
                drop(map);
                let _ = monitor_app.emit(
                    "plx://term",
                    TermChunk { id, kind: "exit".into(), line: status.code().unwrap_or(-1).to_string() },
                );
                break;
            }
            Some(Ok(None)) => continue,   // ещё работает
            Some(Err(_)) | None => break, // убит через kill_command
        }
    });

    Ok(id)
}

/// Остановить запущенную команду (кнопка «Стоп» терминала).
#[tauri::command]
fn kill_command(registry: State<'_, ProcRegistry>, id: u64) -> Result<(), String> {
    let mut map = registry.0.lock().unwrap();
    if let Some(child) = map.get_mut(&id) {
        child.kill().map_err(|e| e.to_string())?;
        map.remove(&id);
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Снимок живой страницы                                               */
/* ------------------------------------------------------------------ */

/// Ожидающие снимки: МЕТКА ОКНА → канал, куда webview положит результат.
///
/// Ключ — именно метка окна, а не число из аргументов. Раньше страница
/// сама сообщала `id`, то есть чужой сайт мог назвать любой номер и
/// подменить результат соседнего импорта. Метку окна берёт сам Tauri из
/// того webview, который сделал вызов, — подделать её со стороны страницы
/// нечем.
pub struct SnapRegistry(Mutex<HashMap<String, std::sync::mpsc::Sender<String>>>);

/// ПОСЛЕДНИЙ ДОСТИГНУТЫЙ ЭТАП СНИМКА, по метке окна.
///
/// Без этого отказ неразличим: «страница не отдала снимок» одинаково
/// выглядит и когда права ACL не пустили вызов, и когда окно заморожено
/// системой, и когда сайт подсунул стену антибота. Три разные причины —
/// три разных действия, а сообщение было одно на всех.
///
/// Этапы приходят из самой страницы: `bridge` (мост доступен), `load`
/// (документ загружен), `settled` (сборщик дождался шрифтов), `collected:N`
/// (снято N узлов). Если не пришёл даже `bridge` — виноваты права или
/// скрипт не исполнился; если пришёл `bridge`, но не `load` — окно не
/// работает; если `collected`, но результата нет — потерялся сам ответ.
pub struct SnapStages(Mutex<HashMap<String, String>>);

static NEXT_SNAP_ID: AtomicU64 = AtomicU64::new(1);

/// Потолок на размер снимка: страница отдаёт его сама, и доверять её
/// аппетиту нельзя. ~24 МБ хватает на страницу в 4000 узлов с запасом.
const SNAP_MAX_BYTES: usize = 24 * 1024 * 1024;

/// Отдать результат ожидающему `capture_snapshot` — ровно один раз.
fn deliver(registry: &State<'_, SnapRegistry>, label: &str, payload: String) {
    // забираем отправителя: повторный вызов из той же страницы уже
    // ничего не изменит, а окно всё равно закрывается сразу после
    let tx = registry.0.lock().unwrap().remove(label);
    if let Some(tx) = tx {
        let _ = tx.send(payload);
    }
}

/// Страница сообщает, до какого этапа дошла. Вызывается ИЗ окна снимка.
#[tauri::command]
fn snapshot_stage(webview: tauri::Webview, stages: State<'_, SnapStages>, stage: String) {
    let label = webview.label().to_string();
    let short: String = stage.chars().take(40).collect();
    stages.0.lock().unwrap().insert(label, short);
}

/// Страница отдаёт снимок обратно: вызывается ИЗ скрытого окна снимка.
#[tauri::command]
fn snapshot_result(
    webview: tauri::Webview,
    registry: State<'_, SnapRegistry>,
    payload: String,
) -> Result<(), String> {
    if payload.len() > SNAP_MAX_BYTES {
        deliver(
            &registry,
            webview.label(),
            "{\"error\":\"снимок страницы слишком велик\"}".to_string(),
        );
        return Err("снимок страницы слишком велик".into());
    }
    deliver(&registry, webview.label(), payload);
    Ok(())
}

/// Ошибка сборки снимка внутри страницы.
#[tauri::command]
fn snapshot_failed(
    webview: tauri::Webview,
    registry: State<'_, SnapRegistry>,
    message: String,
) -> Result<(), String> {
    let short: String = message.chars().take(500).collect();
    deliver(
        &registry,
        webview.label(),
        format!(
            "{{\"error\":{}}}",
            serde_json::to_string(&short).unwrap_or_else(|_| "\"неизвестная ошибка\"".into())
        ),
    );
    Ok(())
}

/// СНИМОК СТРАНИЦЫ В НАСТОЯЩЕМ БРАУЗЕРЕ.
///
/// Открывает скрытое окно webview, даёт странице собраться (JS, шрифты,
/// картинки) и просит внедрённый скрипт снять с неё геометрию и
/// вычисленные стили. Так импортируются сайты, которых в серверном HTML
/// физически нет: SPA отдают каркас, а здесь страница уже построена.
///
/// Скрипт передаётся снаружи (`collector`), чтобы сборщик был ОДИН и тот же
/// для десктопа и для браузерного режима — иначе снимки несравнимы.
#[tauri::command]
async fn capture_snapshot(
    app: AppHandle,
    registry: State<'_, SnapRegistry>,
    stages: State<'_, SnapStages>,
    url: String,
    collector: String,
    width: u32,
    height: u32,
    timeout_ms: u64,
) -> Result<String, String> {
    /* Адрес разбираем ДО открытия окна и пускаем только http(s):
       capability окна снимка выдана источникам `http://*` и `https://*`,
       а file:// или чужая схема в скрытом окне нам не нужны вовсе. */
    let target: tauri::Url = url.parse().map_err(|e| format!("плохой адрес: {e}"))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err("снимок делается только по http и https".into());
    }

    let id = NEXT_SNAP_ID.fetch_add(1, Ordering::SeqCst);
    let label = format!("plx-snap-{id}");
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    registry.0.lock().unwrap().insert(label.clone(), tx);

    /* Скрипт-обёртка: ждёт сборку, снимает, отдаёт результат через IPC.
       Ошибку тоже сообщаем — молчащий импорт хуже честной ошибки.
       Номера запроса в скрипте НЕТ: ожидающий канал ищется по метке окна,
       которую подставляет Tauri, а не страница.

       Собираем конкатенацией, а не `format!`: текст сборщика полон фигурных
       скобок, и экранировать их в шаблоне — верный способ ошибиться. */
    let bootstrap = String::new()
        + "(function () {\n"
        + "  if (window.__plxSnapDone) return;\n"
        + "  window.__plxSnapDone = true;\n"
        + "  function send(cmd, args) {\n"
        + "    try {\n"
        + "      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {\n"
        + "        window.__TAURI_INTERNALS__.invoke(cmd, args);\n"
        + "      }\n"
        + "    } catch (e) { /* мост недоступен — окно закроется по таймауту */ }\n"
        + "  }\n"
        // ЭТАПЫ. Без них отказ неразличим: права ACL, замороженное окно и
        // стена антибота дают один и тот же таймаут. Страница сообщает, до
        // чего дошла, и последний этап попадает в текст ошибки.
        + "  function stage(s) { send('snapshot_stage', { stage: s }); }\n"
        + "  stage('bridge');\n"
        + "  if (document.readyState === 'complete') { stage('load'); }\n"
        + "  else { window.addEventListener('load', function () { stage('load'); }, { once: true }); }\n"
        + "  Promise.resolve()\n"
        + "    .then(function () { return (\n"
        + &collector
        + "\n); })\n"
        + "    .then(function (snap) {\n"
        + "      stage('collected:' + ((snap && snap.nodes && snap.nodes.length) || 0));\n"
        + "      send('snapshot_result', { payload: JSON.stringify(snap) });\n"
        + "    })\n"
        + "    .catch(function (e) { send('snapshot_failed', { message: String((e && e.message) || e) }); });\n"
        + "})();\n";

    let window = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::External(target),
    )
    .title("Plexus: снимок страницы")
    .inner_size(width as f64, height as f64)
    // ЗА ПРЕДЕЛАМИ ЭКРАНА, НО ВИДИМОЕ. Скрытое окно (`visible(false)`)
    // операционная система вправе считать невидимым и заморозить webview:
    // таймеры не идут, раскладка не считается, сборщик не доходит до конца
    // и снимок неизменно истекает по таймауту. Поэтому окно остаётся
    // «видимым» для системы, но уносится далеко за границы рабочего стола.
    .visible(true)
    .position(-32000.0, -32000.0)
    .skip_taskbar(true)
    .focused(false)
    // сеанс не сохраняется: чужие куки и хранилище не переживают снимок
    .incognito(true)
    .disable_drag_drop_handler()
    // редирект на file:// или на app-схему из скрытого окна — не наш случай
    .on_navigation(|u| matches!(u.scheme(), "http" | "https"))
    // главный фрейм, не все: сборщик не должен попадать в чужие iframe
    .initialization_script(&bootstrap)
    .build()
    .map_err(|e| {
        registry.0.lock().unwrap().remove(&label);
        format!("не удалось открыть окно снимка: {e}")
    })?;

    let wait = std::time::Duration::from_millis(timeout_ms.clamp(3_000, 60_000));
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(wait))
        .await
        .map_err(|e| e.to_string())?;

    registry.0.lock().unwrap().remove(&label);
    let stage = stages.0.lock().unwrap().remove(&label);
    let _ = window.close();

    match result {
        Ok(payload) => Ok(payload),
        Err(_) => Err(match stage.as_deref() {
            None => "снимок не начался: страница не вышла на связь. \
                     Скорее всего мост IPC недоступен окну снимка (права ACL) \
                     либо сайт не дал исполнить скрипт"
                .to_string(),
            Some("bridge") => "страница вышла на связь, но документ так и не загрузился: \
                               окно снимка, похоже, приостановлено системой либо сайт \
                               не отвечает"
                .to_string(),
            Some("load") => "документ загрузился, но сборщик не дождался готовности \
                             (шрифты или гидратация): попробуйте увеличить таймаут"
                .to_string(),
            Some(other) if other.starts_with("collected") => format!(
                "снимок снят ({other}), но результат не дошёл до приложения: \
                 возможно, он превысил допустимый размер"
            ),
            Some(other) => format!("снимок остановился на этапе «{other}»"),
        }),
    }
}

/// Точка входа. Атрибут мобильной точки входа раньше стоял этажом выше и
/// прилипал к объявлению `SnapRegistry`, а не к этой функции: на десктопе
/// `mobile` выключен и он просто исчезал, поэтому ошибку никто не видел.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcRegistry(Mutex::new(HashMap::new())))
        .manage(SnapRegistry(Mutex::new(HashMap::new())))
        .manage(SnapStages(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            home_dir,
            project_root,
            list_dir,
            read_text_file,
            write_text_file,
            copy_into_assets,
            fetch_url,
            run_command,
            start_command,
            kill_command,
            capture_snapshot,
            snapshot_result,
            snapshot_stage,
            snapshot_failed
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска Plexus");
}
