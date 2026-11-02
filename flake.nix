{
  description = "MCP servers Arbora owns";

  # Pins borrowed from Firefly Engineering through `toolbox`, as
  # arbora-partners/IaC does, locked to the same toolbox revision so the two
  # repos' shells carry the same tools.
  inputs = {
    toolbox.url = "github:firefly-engineering/toolbox";
    nixpkgs.follows = "toolbox/nix-pins/nixpkgs";
    flake-parts.follows = "toolbox/nix-pins/flake-parts";
    systems.follows = "toolbox/nix-pins/systems";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = import inputs.systems;

      perSystem =
        { pkgs, system, ... }:
        let
          toolbox = inputs.toolbox.packages.${system};
        in
        {
          devShells.default = pkgs.mkShellNoCC {
            packages = [
              # Node floats, as in IaC: CI pins only the major (`node-version: '22'`).
              toolbox.nodejs
              # pnpm at the versioned attribute `packageManager` names, never the
              # floating one (IaC #435).
              toolbox.pnpm-12_3_4
              # biome tracks biome.json's `$schema` and checks.yml's setup-biome.
              toolbox.biome
              toolbox.just
            ];
          };
        };
    };
}
