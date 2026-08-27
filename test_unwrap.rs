fn main() {
    let opt = Some(5);
    use soroban_sdk::unwrap::UnwrapOptimized;
    let _ = opt.unwrap_optimized();
}
