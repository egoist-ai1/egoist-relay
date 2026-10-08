fn main() {
  println!("cargo:rerun-if-changed=../scripts/telegram-transport.mjs");
  println!("cargo:rerun-if-changed=../scripts/mini-app-bridge.js");
  println!("cargo:rerun-if-changed=../scripts/build-telegram-transport.mjs");
  println!("cargo:rerun-if-changed=../package-lock.json");
  let project = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("..");
  let bundled_node = project.join("runtime/node.exe");
  let node = if cfg!(windows) && bundled_node.is_file() { bundled_node } else { "node".into() };
  let outfile = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("telegram-transport.cjs");
  let status = std::process::Command::new(node).current_dir(&project)
    .arg("scripts/build-telegram-transport.mjs").arg("--outfile").arg(outfile).status()
    .expect("Cannot bundle the Telegram transport adapter with the existing Node toolchain");
  assert!(status.success(), "Cannot bundle the Telegram transport adapter");
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
          "set_window_title",
          "open_new_window_cmd",
          "save_current_url",
          "set_menu_translations",
          "relay_control_status",
          "relay_get_telegram_transport",
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
          "relay_media_download_prepare",
          "relay_media_download_file_name",
          "relay_media_operation_source",
          "multi_set_content_visible",
          "multi_social_save_media",
          "multi_social_detach",
          "multi_social_release",
          "multi_social_restore",
          "relay_inline_resolve_media",
          "relay_inline_save_media",
          "relay_inline_cancel_media",
          "transcribe_voice",
          "cancel_voice_transcription",
          "relay_set_theme",
        ]),
      ),
  )
  .expect("Failed to build Tauri application")
}
