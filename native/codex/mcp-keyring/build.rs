fn main() {
    println!("cargo:rerun-if-changed=private_acl.c");
    cc::Build::new().file("private_acl.c").warnings_into_errors(true).compile("private_acl");
}
