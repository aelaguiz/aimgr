fn main() {
    let mut build = cc::Build::new();
    build.file("boundary.c").warnings_into_errors(true);
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build.flag("-Wno-deprecated-declarations");
    }
    build.compile("aim_config_boundary");
    println!("cargo:rerun-if-changed=boundary.c");
}
