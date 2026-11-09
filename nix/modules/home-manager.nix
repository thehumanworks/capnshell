# Home Manager module: services.cns runs this user's paired daemon (`cns up`)
# as a systemd user service on Linux or a launchd agent on macOS, declared by
# Nix instead of written by `cns up --install`. The service file has the name
# and the --state argument `cns up --install` would write, so `cns up` starts
# the daemon through it after `cns stop`, as with an installed service.
self:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.cns;
  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux system;
  exe = lib.getExe cfg.package;
  args = [ "daemon" "--service" "--state" cfg.stateFile "--bind" cfg.bind "--port" (toString cfg.port) ];
  # Commands paired devices run get the daemon's PATH, not a login shell's.
  defaultPath = lib.concatStringsSep ":" ([
    "${config.home.profileDirectory}/bin"
    "/etc/profiles/per-user/${config.home.username}/bin"
    "/run/current-system/sw/bin"
    "/nix/var/nix/profiles/default/bin"
  ] ++ lib.optionals isDarwin [ "/opt/homebrew/bin" ] ++ [ "/usr/local/bin" "/usr/bin" "/bin" "/usr/sbin" "/sbin" ]);
  environment = { PATH = defaultPath; } // cfg.environment;
  # The same quoting as src/service.ts, which `cns up` matches the state file against.
  quote = value: ''"${lib.replaceStrings [ "\\" "\"" "%" "$" ] [ "\\\\" "\\\"" "%%" "$$" ] value}"'';
in
{
  options.services.cns = {
    enable = lib.mkEnableOption "the cns peer daemon for paired devices";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${system}.default;
      defaultText = lib.literalExpression "capnshell.packages.\${system}.default";
      description = "The cns package. It is also added to home.packages.";
    };
    bind = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Numeric address the daemon listens on. Only paired devices that authenticate can connect.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 47381;
      description = "TCP port the daemon listens on.";
    };
    stateFile = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.cns/daemon.json";
      defaultText = lib.literalExpression ''"''${config.home.homeDirectory}/.cns/daemon.json"'';
      description = "The daemon's state file; cns up, attach and stop find the daemon by it.";
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = { CNS_CONFIG_DIR = "/home/me/.config/cns"; };
      description = ''
        Environment for the daemon, added to a PATH of the usual Nix profile
        directories (set PATH here to replace it). Commands that paired devices
        run inherit it. Use `cns config relay` for a relay, not this: values
        here are readable in the Nix store.
      '';
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    { home.packages = [ cfg.package ]; }

    (lib.mkIf isLinux {
      systemd.user.services.cns = {
        Unit = {
          Description = "cns peer daemon for paired devices";
          Wants = [ "network-online.target" ];
          After = [ "network-online.target" ];
          StartLimitIntervalSec = 0;
        };
        Service = {
          Type = "simple";
          # The daemon needs this device's identity; `cns identity` creates it on first use.
          ExecStartPre = "${quote exe} identity";
          ExecStart = lib.concatMapStringsSep " " quote ([ exe ] ++ args);
          Environment = lib.mapAttrsToList (name: value: ''"${lib.replaceStrings [ "\\" "\"" "%" ] [ "\\\\" "\\\"" "%%" ] "${name}=${value}"}"'') environment;
          # cns stop ends the daemon with status 0; it stays stopped until cns up or the next login.
          Restart = "on-failure";
          RestartSec = 5;
        };
        Install.WantedBy = [ "default.target" ];
      };
    })

    (lib.mkIf isDarwin {
      # launchd opens the log before starting cns, so its directory must exist.
      home.activation.cnsLogDirectory = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run mkdir -p -m 700 ${lib.escapeShellArg (dirOf cfg.stateFile)}
      '';
      launchd.agents.cns = {
        enable = true;
        config = {
          # The label `cns up --install` uses, which `cns up` restarts the daemon by.
          Label = "com.thehumanworks.cns";
          ProgramArguments = [ "/bin/sh" "-c" ''"$0" identity >/dev/null && exec "$0" "$@"'' exe ] ++ args;
          EnvironmentVariables = environment;
          RunAtLoad = true;
          KeepAlive.SuccessfulExit = false;
          ThrottleInterval = 10;
          ProcessType = "Background";
          StandardOutPath = "${dirOf cfg.stateFile}/service.log";
          StandardErrorPath = "${dirOf cfg.stateFile}/service.log";
        };
      };
    })
  ]);
}
