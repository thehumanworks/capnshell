{
  description = "Standalone Bun-compiled Cap'n Web shell peers";

  # An exact commit, so `nix flake update` can only move it by editing this line.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/e62746b0b472753ef019baceab6f1e2e52014980";

  outputs = { self, nixpkgs }:
    let
      # The platforms nix/bun.nix has Bun releases for (not Intel macOS).
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          bun = pkgs.callPackage ./nix/bun.nix { };
          capnweb-shell = pkgs.callPackage ./nix/package.nix { inherit bun; };
        in {
          inherit capnweb-shell;
          cns = capnweb-shell;
          default = capnweb-shell;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/cns";
          meta.description = "Bidirectional Cap'n Web shell CLI";
        };
        capnweb-shell = self.apps.${system}.default;
        cns = self.apps.${system}.default;
      });

      devShells = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = [ (pkgs.callPackage ./nix/bun.nix { }) pkgs.bash pkgs.git ];
            shellHook = ''
              echo "capnweb-shell: bun install --frozen-lockfile --ignore-scripts; bun run build"
            '';
          };
        });

      checks = forAllSystems (system: {
        package = self.packages.${system}.default;
      });
    };
}
