// Не показывать консольное окно на Windows в release-сборке
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    plexus_lib::run()
}
