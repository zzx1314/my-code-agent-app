use tauri::{
  plugin::{Builder, TauriPlugin},
  AppHandle, Manager, Runtime,
};

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;
#[cfg(not(target_os = "android"))]
use std::marker::PhantomData;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.zhangzexin.my_code_agent_app.share";

pub struct SharePlugin<R: Runtime> {
  #[cfg(target_os = "android")]
  mobile_plugin_handle: PluginHandle<R>,
  #[cfg(not(target_os = "android"))]
  _marker: PhantomData<fn() -> R>,
}

#[tauri::command]
async fn share_file<R: Runtime>(
  app: AppHandle<R>,
  name: String,
  contents: Vec<u8>,
  mime: String,
) -> Result<bool, String> {
  let cache_dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| format!("Failed to get cache dir: {e}"))?;
  let file_path = cache_dir.join(&name);
  std::fs::write(&file_path, &contents)
    .map_err(|e| format!("Failed to write file: {e}"))?;

  #[cfg(target_os = "android")]
  {
    let plugin = app.state::<SharePlugin<R>>();
    plugin
      .mobile_plugin_handle
      .run_mobile_plugin::<()>(
        "share",
        serde_json::json!({
          "path": file_path.to_string_lossy(),
          "mime": mime,
        }),
      )
      .map_err(|e| format!("Share failed: {e}"))?;
    return Ok(true);
  }

  #[cfg(not(target_os = "android"))]
  {
    let _ = (file_path, mime);
    return Ok(false);
  }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("share")
    .setup(|app, api| {
      #[cfg(target_os = "android")]
      let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SharePlugin")?;
      #[cfg(not(target_os = "android"))]
      let _ = api;

      app.manage(SharePlugin::<R> {
        #[cfg(target_os = "android")]
        mobile_plugin_handle: handle,
        #[cfg(not(target_os = "android"))]
        _marker: PhantomData,
      });
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![share_file])
    .build()
}
