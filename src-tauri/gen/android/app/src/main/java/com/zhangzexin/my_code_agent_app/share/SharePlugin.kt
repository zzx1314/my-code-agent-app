package com.zhangzexin.my_code_agent_app.share

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {
  lateinit var path: String
  lateinit var mime: String
}

@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun share(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(ShareArgs::class.java)
      val file = File(args.path)

      if (!file.exists()) {
        invoke.reject("File not found: ${args.path}")
        return
      }

      val authority = "${activity.packageName}.fileprovider"
      val uri = FileProvider.getUriForFile(activity, authority, file)
      val intent = Intent(Intent.ACTION_SEND).apply {
        type = args.mime
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }

      val chooser = Intent.createChooser(intent, null)
      activity.startActivity(chooser)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Unknown error")
    }
  }
}
