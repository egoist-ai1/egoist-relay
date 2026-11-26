/// Вшивает токен чтения релизов в `OUT_DIR/update_token.txt`. Содержимое файла никуда не печатается.
/// Путь: `BERESTA_UPDATE_TOKEN_FILE`, иначе `%LOCALAPPDATA%\Egoist\sign\beresta-update-token.txt`.
/// Нет файла → пустая строка (обновления выключены); при `BERESTA_RELEASE=1` это ошибка сборки.
fn embed_update_token() {
  println!("cargo:rerun-if-env-changed=BERESTA_UPDATE_TOKEN_FILE");
  println!("cargo:rerun-if-env-changed=BERESTA_RELEASE");
  println!("cargo:rerun-if-env-changed=LOCALAPPDATA");
  let path = std::env::var_os("BERESTA_UPDATE_TOKEN_FILE")
    .map(std::path::PathBuf::from)
    .or_else(|| {
      std::env::var_os("LOCALAPPDATA").map(|base| {
        std::path::PathBuf::from(base).join("Egoist").join("sign").join("beresta-update-token.txt")
      })
    });
  let release = std::env::var("BERESTA_RELEASE").as_deref() == Ok("1");
  let mut token = String::new();
  if let Some(path) = &path {
    println!("cargo:rerun-if-changed={}", path.display());
    if let Ok(raw) = std::fs::read_to_string(path) {
      let trimmed = raw.trim();
      let valid = !trimmed.is_empty()
        && trimmed.len() <= 255
        && trimmed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
      if valid {
        token = trimmed.to_string();
      } else if release {
        panic!("BERESTA_RELEASE=1: файл токена обновлений пуст или содержит недопустимые символы");
      }
    }
  }
  if release && token.is_empty() {
    panic!("BERESTA_RELEASE=1: токен обновлений не найден (BERESTA_UPDATE_TOKEN_FILE или Egoist\\sign\\beresta-update-token.txt)");
  }
  let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("update_token.txt");
  std::fs::write(out, token).expect("Cannot write the update token stub");
}

fn main() {
  embed_update_token();
  println!("cargo:rerun-if-changed=../scripts/mini-app-bridge.js");
  let windows_manifest = r#"
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10 and Windows 11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
"#;

  let windows_attrs = tauri_build::WindowsAttributes::new().app_manifest(windows_manifest);

  tauri_build::try_build(
    tauri_build::Attributes::new()
      .windows_attributes(windows_attrs)
      .app_manifest(
        tauri_build::AppManifest::new().commands(&[
          "mark_title_bar_overlay",
          "set_notifications_count",
          "relay_lagom_telegram_notice",
          "set_window_title",
          "open_new_window_cmd",
          "save_current_url",
          "set_menu_translations",
          "relay_control_status",
          "relay_mcp_launch_config",
          "relay_take_deep_links",
          "relay_research_ready",
          "relay_research_reply",
          "relay_research_media_chunk",
          "relay_research_social_reply",
          "get_default_install_dir",
          "choose_install_dir",
          "minimize_installer",
          "close_installer",
          "launch_installed_app",
          "perform_install",
          "multi_set_active_app",
          "multi_prewarm_x",
          "multi_prewarm_instagram",
          "multi_update_x_bounds",
          "multi_x_navigate",
          "multi_instagram_navigate",
          "multi_open_external",
          "multi_social_overlay",
          "multi_social_cancel_media",
          "multi_social_read_media",
          "multi_social_set_labels",
          "relay_mini_app_open",
          "relay_mini_app_update",
          "relay_mini_app_reload",
          "relay_mini_app_send",
          "relay_mini_app_close",
          "relay_media_operations_list",
          "relay_media_operation_action",
          "relay_media_operation_revision",
          "relay_library_list",
          "relay_library_action",
          "relay_telegram_download_queue",
          "relay_media_download_prepare",
          "relay_media_download_file_name",
          "relay_media_operation_source",
          "multi_set_content_visible",
          "multi_social_save_media",
          "relay_social_stage_file",
          "relay_social_read_staged_chunk",
          "relay_social_release_staged_file",
          "multi_social_detach",
          "multi_social_release",
          "multi_social_restore",
          "relay_inline_resolve_media",
          "relay_inline_save_media",
          "relay_inline_cancel_media",
          "transcribe_voice",
          "cancel_voice_transcription",
          "relay_set_theme",
          "relay_clear_webview_cache",
          "update_check",
          "update_install",
          "update_get_mode",
          "update_set_mode",
        ]),
      ),
  )
  .expect("Failed to build Tauri application")
}
