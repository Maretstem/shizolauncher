# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

Only the Windows installer `ShizoLauncher Setup X.Y.Z.exe` attached to [GitHub Releases](https://github.com/Maretstem/shizolauncher/releases).
It is built from this repository by the [build workflow](.github/workflows/build.yml) on GitHub-hosted runners — never on a developer machine.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [Maretstem](https://github.com/Maretstem) |
| Approvers | [Maretstem](https://github.com/Maretstem) |

Every signing request for a release is approved manually by an approver.
All team members use multi-factor authentication for GitHub and SignPath.

## Privacy policy

ShizoLauncher has no telemetry, analytics or advertising and does not collect personal data.
It connects only to the following systems, each for the stated purpose:

| System | Purpose | When |
|---|---|---|
| `github.com`, `api.github.com` | check for and download launcher updates | on start |
| `maretstem.github.io` | download the SHIZOSTAN server mod pack | on start, on Play |
| `play.shizostan.fun` | show the server's player count and ping (Minecraft Server List Ping) | on start, every minute |
| Mojang (`*.mojang.com`, `*.minecraft.net`) | download the game, libraries, assets and Java | on Play / install |
| Fabric, Quilt, Forge, NeoForge Maven servers | download the selected mod loader | on Play / install |
| `api.modrinth.com`, `cdn.modrinth.com` | search, install and update mods and mod packs | only when the user opens these features |
| Microsoft / Xbox Live (`login.microsoftonline.com`, `*.xboxlive.com`, `api.minecraftservices.com`) | sign in with a Microsoft account | only when the user signs in |
| `ely.by` or an authentication server entered by the user | sign in with that account | only when the user signs in or plays with it |
| `authlib-injector.yushi.moe` | download authlib-injector for Ely.by / custom accounts | when such an account is used |

Account tokens are stored locally, encrypted with the operating system key (Windows DPAPI). Passwords are never stored.
