# Consumer-level regression checks using the exported modules and real module systems.
# Supply the project flake as cns and a pinned Home Manager flake as homeManager.
{ cns, homeManager, system ? "x86_64-linux" }:
let
  nixpkgs = cns.inputs.nixpkgs;
  pkgs = import nixpkgs { inherit system; };
  lib = nixpkgs.lib;
  nixos = extra: lib.nixosSystem {
    modules = [ cns.nixosModules.default {
      nixpkgs.hostPlatform = system;
      boot.isContainer = true;
      system.stateVersion = "25.11";
      users.users.alice = { isNormalUser = true; home = "/home/alice"; };
      services.cns = { enable = true; user = "alice"; };
    } extra ];
  };
  normal = nixos {};
  custom = nixos { services.cns.environment.NODE_EXTRA_CA_CERTS = "/custom/ca.pem"; };
  home = extra: homeManager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [ cns.homeModules.default {
      home.username = "alice";
      home.homeDirectory = "/home/alice";
      home.stateVersion = "25.11";
      services.cns.enable = true;
      home.sessionVariables = {
        NODE_EXTRA_CA_CERTS = "/declared/ca.pem";
        SSL_CERT_FILE = "/declared/bundle.crt";
        SSL_CERT_DIR = "/declared/certs";
        SECRET = "must-not-leak";
        NODE_TLS_REJECT_UNAUTHORIZED = "0";
      };
    } extra ];
  };
  user = home {};
  userCustom = home { services.cns.environment.NODE_EXTRA_CA_CERTS = "/override/ca.pem"; };
  disabled = home { services.cns.enable = lib.mkForce false; };
  expected = [ "\"NODE_EXTRA_CA_CERTS=/declared/ca.pem\"" "\"SSL_CERT_FILE=/declared/bundle.crt\"" "\"SSL_CERT_DIR=/declared/certs\"" ];
in
assert normal.config.systemd.services.cns.environment.NODE_EXTRA_CA_CERTS == normal.config.security.pki.caBundle;
assert normal.config.systemd.services.cns.environment.SSL_CERT_FILE == normal.config.security.pki.caBundle;
assert custom.config.systemd.services.cns.environment.NODE_EXTRA_CA_CERTS == "/custom/ca.pem";
assert lib.all (v: builtins.elem v user.config.systemd.user.services.cns.Service.Environment) expected;
assert lib.all (v: !(lib.hasInfix "SECRET" v || lib.hasInfix "NODE_TLS_REJECT_UNAUTHORIZED" v)) user.config.systemd.user.services.cns.Service.Environment;
assert builtins.elem "\"NODE_EXTRA_CA_CERTS=/override/ca.pem\"" userCustom.config.systemd.user.services.cns.Service.Environment;
assert !(disabled.config.systemd.user.services ? cns);
{
  nixosUnit = normal.config.systemd.units."cns.service".unit;
  homeActivation = user.activationPackage;
  checks = "NixOS CA defaults/override and Home Manager CA inheritance/override/secret exclusion/disabled service passed";
}
