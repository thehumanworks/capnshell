{ lib, stdenvNoCC, bun, bash, coreutils, writableTmpDirAsHomeHook }:
let
  manifest = lib.importJSON ../package.json;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src ../nix ../package.json ../bun.lock ../tsconfig.json
      ../flake.nix ../flake.lock ../README.md
    ];
  };
  # Follow nixpkgs' Bun packaging pattern: only this fixed-output derivation
  # accesses the network. The compiler and tests below build offline.
  dependencies = stdenvNoCC.mkDerivation {
    pname = "capnweb-shell-dependencies";
    version = manifest.version;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [ ../package.json ../bun.lock ];
    };
    nativeBuildInputs = [ bun writableTmpDirAsHomeHook ];
    dontConfigure = true;
    dontFixup = true;
    buildPhase = ''
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      bun install --production --frozen-lockfile --ignore-scripts --no-progress --cpu="*" --os="*"
    '';
    installPhase = ''
      mkdir -p "$out"
      cp -R node_modules "$out/"
    '';
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-gZIw/W6i4uj7yNYYOayzE/v/sfR+NaPgd5XWlhQwqqA=";
  };
in
stdenvNoCC.mkDerivation {
  pname = "capnweb-shell";
  version = manifest.version;
  inherit src;
  nativeBuildInputs = [ bun writableTmpDirAsHomeHook ];
  nativeCheckInputs = [ bash coreutils ];
  strictDeps = true;
  dontConfigure = true;
  # Bun appends its module bundle to the executable; stripping would corrupt it.
  dontStrip = true;
  dontPatchELF = true;
  buildPhase = ''
    runHook preBuild
    cp -R ${dependencies}/node_modules .
    bun run build \
      --define 'CAPNWEB_DEFAULT_BASH="${bash}/bin/bash"'
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    # Network tests run with `bun run test:compiled` outside the Nix sandbox.
    bun test --timeout 30000 src/options.test.ts src/shell.test.ts
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 dist/cns "$out/bin/cns"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    "$out/bin/cns" --help
  '';
  passthru = { inherit dependencies; };
  meta = {
    description = "Standalone bidirectional Cap'n Web shell peers, compiled with Bun";
    mainProgram = "cns";
    platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
  };
}
