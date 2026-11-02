pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Slate could not start.");
}
