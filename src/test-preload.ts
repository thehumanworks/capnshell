// Tests never reach the relay built into cns: a test that needs a relay starts its own
// and points cns at it with CNS_RELAY. This also overrides a CNS_RELAY from a local .env.
process.env.CNS_RELAY = "off";
