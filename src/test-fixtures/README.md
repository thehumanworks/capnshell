# Test-only relay TLS certificate

`relay-cert.pem` and `relay-key.pem` are a public, disposable self-signed test
certificate and private key. They are not production credentials and must never
be used for a deployed service. The certificate covers only `localhost`, `::1`
and `127.0.0.1`; `src/relay-client.test.ts` uses it to prove that an untrusted relay
is rejected and that explicit CA trust enables registration without disabling TLS
verification.

Regenerate before expiry (2036-11-06), then run the source and compiled relay-client
tests. From the repository root, with OpenSSL installed or through the pinned input:

```sh
nix shell --inputs-from . nixpkgs#openssl -c openssl req \
  -x509 -newkey rsa:2048 -noenc -days 3650 \
  -subj '/CN=cns-test-only-relay' \
  -addext 'subjectAltName=IP:::1,IP:127.0.0.1,DNS:localhost' \
  -keyout src/test-fixtures/relay-key.pem \
  -out src/test-fixtures/relay-cert.pem
```
