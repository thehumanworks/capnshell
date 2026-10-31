# Bun comes from its own release hashes here, so that updating nixpkgs can't
# change it. Bun's version decides what `bun install` writes, and so the
# dependency hash in package.nix. To update: change package.json's
# packageManager, then the version and hashes below, then that dependency hash.
{ lib, bun, fetchurl }:
let
  version = "1.4.4";
  release = file: hash: fetchurl {
    url = "https://github.com/oven-sh/bun/releases/download/bun-v${version}/${file}";
    inherit hash;
  };
  declared = (lib.importJSON ../package.json).packageManager;
in
assert lib.assertMsg (declared == "bun@${version}")
  "nix/bun.nix pins bun@${version} but package.json declares ${declared}";
bun.overrideAttrs (old: {
  inherit version;
  # bun takes src from passthru.sources, so the check for a changed src misses it.
  __intentionallyOverridingVersion = true;
  passthru = old.passthru // {
    sources = {
      aarch64-darwin = release "bun-darwin-aarch64.zip" "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
      aarch64-linux = release "bun-linux-aarch64.zip" "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
      x86_64-linux = release "bun-linux-x64-baseline.zip" "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY=";
    };
  };
})
