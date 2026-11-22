// Tests never reach the relay built into cns: a test that needs a relay starts its own
// and points cns at it with CNS_RELAY. This also overrides a CNS_RELAY from a local .env.
process.env.CNS_RELAY = "off";
// Nor do they run as a mesh bot unless a test sets CNS_TOKEN itself.
delete process.env.CNS_TOKEN;
