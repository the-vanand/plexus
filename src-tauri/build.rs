/// Сборка Tauri + СПИСОК СОБСТВЕННЫХ КОМАНД ПРИЛОЖЕНИЯ.
///
/// Без `app_manifest` команды приложения вообще не попадают в ACL: у них
/// нет разрешений, на которые могла бы сослаться capability, — а значит
/// выдать окну снимка `snapshot_result` было физически нечем. Объявленный
/// список решает сразу две задачи:
///
///  1. `tauri-build` порождает разрешения `allow-<команда>` и
///     `deny-<команда>` (подчёркивания заменяются дефисами), которыми
///     можно раздавать доступ поокно;
///  2. включается проверка ACL для команд приложения — окно получает
///     ровно то, что ему выдали, и ни командой больше.
///
/// Список обязан совпадать с `generate_handler!` в `src/lib.rs`,
/// разрешения раздаются в `capabilities/`.
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "home_dir",
            "project_root",
            "list_dir",
            "read_text_file",
            "write_text_file",
            "copy_into_assets",
            "fetch_url",
            "run_command",
            "start_command",
            "kill_command",
            "capture_snapshot",
            "snapshot_result",
            "snapshot_failed",
        ])),
    )
    .expect("не удалось собрать манифест разрешений Tauri")
}
