// Ресурсы exe: иконка, версия, название «Sennit Setup», манифест (asInvoker, UTF-8).
fn main() {
    println!("cargo:rerun-if-changed=assets");
    println!("cargo:rerun-if-changed=build.rs");
    // Защита от подкладывания DLL рядом с exe: библиотеки вне KnownDLLs грузим отложенно, уже после
    // SetDefaultDllDirectories(System32), который вызывается первым действием main.
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
        for dll in ["dwmapi.dll", "comctl32.dll", "bcryptprimitives.dll"] {
            println!("cargo:rustc-link-arg-bins=/DELAYLOAD:{dll}");
        }
    }
    #[cfg(windows)]
    {
        let version = env!("CARGO_PKG_VERSION");
        let mut parts = version.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        let (a, b, c) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0));
        let packed = (a << 48) | (b << 32) | (c << 16);
        let mut res = tauri_winres::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set_manifest(include_str!("assets/sennit-setup.manifest"));
        res.set("ProductName", "Sennit");
        res.set("FileDescription", "Sennit Setup");
        res.set("CompanyName", "Egoist");
        res.set("LegalCopyright", "Sennit by Egoist");
        res.set("OriginalFilename", "Sennit-Setup.exe");
        res.set("InternalName", "Sennit-Setup");
        res.set("FileVersion", version);
        res.set("ProductVersion", version);
        res.set_version_info(tauri_winres::VersionInfo::FILEVERSION, packed);
        res.set_version_info(tauri_winres::VersionInfo::PRODUCTVERSION, packed);
        res.set_language(0x0419);
        if let Err(e) = res.compile() {
            panic!("не удалось встроить ресурсы exe: {e}");
        }
    }
}
