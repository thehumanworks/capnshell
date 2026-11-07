# NixOS module: services.cns runs a user's paired daemon (`cns up`) as a
# system service, so it starts at boot without a login. It runs as that user,
# with the identity, paired devices and state in their ~/.cns, and paired
# devices act as that user within their grants. Manage it with systemctl:
# `cns stop` stops it until the next restart, and `cns up` would then start a
# second, unsupervised daemon.
self:
{ config, lib, pkgs, utils, ... }:
let
  cfg = config.services.cns;
  exe = lib.getExe cfg.package;
  home = config.users.users.${cfg.user}.home;
  stateFile = if cfg.stateFile != null then cfg.stateFile else "${home}/.cns/daemon.json";
in
{
  options.services.cns = {
    enable = lib.mkEnableOption "the cns peer daemon for paired devices";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "capnshell.packages.\${system}.default";
      description = "The cns package. It is also added to environment.systemPackages.";
    };
    user = lib.mkOption {
      type = lib.types.str;
      example = "alice";
      description = "The existing user the daemon runs as; paired devices get that user's access within their grants.";
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
    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the port in the firewall, for paired devices that reach this one directly rather than through the relay.";
    };
    stateFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "The daemon's state file (default: ~/.cns/daemon.json of the user); cns attach and status find the daemon by it.";
    };
    path = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.git ]";
      description = "Packages on the PATH of commands paired devices run, besides the user's profile and the system's packages.";
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = ''
        Extra environment for the daemon and the commands paired devices run.
        Use `cns config relay` for a relay, not this: values here are readable
        in the Nix store.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.cns = {
      description = "cns peer daemon for paired devices";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];
      startLimitIntervalSec = 0;
      environment = cfg.environment // {
        # Commands paired devices run get the daemon's PATH, not a login shell's.
        PATH = lib.mkForce (lib.concatStringsSep ":" (map (p: "${p}/bin") cfg.path ++ [
          "/run/wrappers/bin"
          "/etc/profiles/per-user/${cfg.user}/bin"
          "${home}/.nix-profile/bin"
          "/nix/var/nix/profiles/default/bin"
          "/run/current-system/sw/bin"
        ]));
      };
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        # The daemon needs this device's identity; `cns identity` creates it on first use.
        ExecStartPre = "${exe} identity";
        ExecStart = utils.escapeSystemdExecArgs [ exe "listen" "--no-repl" "--paired" "--service" "--state" stateFile "--bind" cfg.bind "--port" (toString cfg.port) ];
        Restart = "on-failure";
        RestartSec = 5;
      };
    };
  };
}
