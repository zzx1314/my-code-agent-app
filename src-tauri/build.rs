fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new()
      .plugin(
        "share",
        tauri_build::InlinedPlugin::new()
          .commands(&["share_file"])
          .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
      ),
  )
  .expect("failed to build tauri application");
}
