# Tauri + Vanilla

This template should help get you started developing with Tauri in vanilla HTML, CSS and Javascript.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

# android build
```
export PATH=$JAVA_HOME/bin:$PATH
export ANDROID_HOME=/home/zhangzexin/Android/Sdk
export ANDROID_NDK_ROOT=/home/zhangzexin/Android/Sdk/ndk/27.2.12479018
export ANDROID_SDK_ROOT=/home/zhangzexin/Android/Sdk


sdk use java 17.0.18-tem
pnpm tauri android build --apk


# 安装
adb install -r ~/IdeaProjects/ground_control/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk


# 启动模拟器
~/Android/Sdk/emulator/emulator -avd Medium_Phone &
~/Android/Sdk/emulator/emulator -avd Medium_Phone -no-snapshot-load

# debug调试
cargo tauri android dev
```