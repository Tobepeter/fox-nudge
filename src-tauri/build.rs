fn main() {
    // 默认共享密钥只在构建时从环境注入，不进仓库
    println!("cargo:rerun-if-env-changed=FOX_NUDGE_DEFAULT_KEY");
    println!("cargo:rerun-if-env-changed=FOX_NUDGE_DEFAULT_TOKEN");
    println!("cargo:rerun-if-env-changed=FOX_NUDGE_DEFAULT_SERVER");
    println!("cargo:rerun-if-env-changed=FOX_NUDGE_DEFAULT_TOPIC");
    tauri_build::build()
}
