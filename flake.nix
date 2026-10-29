{
  description = "Standalone Bun-compiled Cap'n Web shell peers";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      # Bun 1.4 in nixpkgs supports these platforms (not Intel macOS).
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          capnweb-shell = pkgs.callPackage ./nix/package.nix { };
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
            packages = [ pkgs.bun pkgs.bash pkgs.git ];
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
