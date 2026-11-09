fn main() {
    println!("cargo:rerun-if-changed=private_acl.c");
    cc::Build::new().file("private_acl.c").warnings_into_errors(true).compile("private_acl");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native_access.c");
        cc::Build::new().file("native_access.c").warnings_into_errors(true).compile("native_access");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
    }
}
