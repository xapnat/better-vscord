# Better VSCord

Fork of [VSCord](https://github.com/LeonardSSH/vscord) that sets your [Discord Rich Presence](https://discord.com/rich-presence) **without a running Discord client**.

Upstream VSCord talks to the local Discord desktop app over IPC, which drops whenever Discord restarts, updates or is not open. Better VSCord instead logs you in once with **your own Discord application** (OAuth2 + PKCE) and updates your activity through Discord's HTTP API (headless sessions). No local Discord, no socket, nothing to reconnect.

All customization settings of VSCord (`vscord.*`) keep working.

## Setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Its name is not important, the shown activity name comes from `vscord.app.name`.
2. **OAuth2 → Redirects**: add `http://127.0.0.1:53682/callback`.
3. **OAuth2 → Public Client**: turn it on (then no client secret is needed). If you leave it off, the extension asks for the client secret once and keeps it in the VS Code secret storage.
4. **Social SDK → Getting Started**: fill in the short form to enable the Social SDK for the application. Without it Discord answers the login with `invalid_scope`.
5. In VS Code set `vscord.app.id` to the application id (client id) of your application.
6. Click **Discord RPC** in the status bar (or run `VSCord: Connect to Discord`). Your browser opens, you approve the application once, done. The login is stored in the VS Code secret storage and refreshed automatically.

Uninstall or disable the original VSCord extension, both use the same setting and command ids.

## Usage

- **Status bar → `Discord RPC`**: click while connected to disconnect and remove your activity from Discord. Click again to connect.
- `VSCord: Authorize with Discord (re-run login)`: log in again, for example after changing the application.
- `VSCord: Remove Discord authorization`: revokes and deletes the stored login.
- `vscord.app.redirectPort`: change it if port `53682` is taken (the redirect URI of your application has to match).

## Good to know

- The consent screen lists a few friends-list related permissions. They are part of `sdk.social_layer_presence`, the only scope that allows setting a presence over HTTP. The extension only sets your activity.
- Headless sessions are not part of Discord's official public documentation, so Discord may change or remove them.
- A session lives for 20 minutes on Discord's side. The extension renews it every 4 minutes and removes it when you disconnect or close the editor. After a crash the activity disappears on its own within 20 minutes.
- With several windows open, the window you are working in owns the single shared activity.
## 📌 Features

- Shows what you're working on!
- Switch between 5 IDE names (`Code`, `Visual Studio Code`, `VSCodium`, `Antigravity` and `Cursor`) or a custom one if you wish!
- Packed with 60+ extension settings!
- Tons of variable to use!
- Support for over 130+ of the most popular languages!
- Support custom images (using HTTP link)
- Support custom button link!
- Support flatpak / snapstore version of Discord!
- Detect when you are Debugging!
- Detect when you are using the [Insiders build](https://code.visualstudio.com/insiders/)!
- Detect when you are Idling!

## 👀 Preview

![1](https://i.imgur.com/LaB4TqM.png)
![2](https://i.imgur.com/yTFIFiK.png)
![3](https://i.imgur.com/5OOkKUW.png)

## 📥 Installation

Launch VS Code Quick Open (Ctrl+P), paste the following command, and press enter.

```
ext install LeonardSSH.vscord
```

**OR**

Use the **[Extension Marketplace](https://code.visualstudio.com/docs/editor/extension-gallery)**

![a4](https://i.imgur.com/qMzox38.gif)

## ⚙️ Configuration

The following variables will be replaced with the respective value in custom strings.<br>

| Variable                              | Value                                              |
| ------------------------------------- | -------------------------------------------------- |
| `{app_name}`                          | current editor name                                |
| `{app_id}`                            | editor name that's suitable for using inside url   |
| `{file_name}`                         | name of the file                                   |
| `{file_extension}`                    | extension of the file                              |
| `{file_size}`                         | size of the file                                   |
| `{folder_and_file}`                   | folder and file name                               |
| `{relative_file_path}`                | filepath relative to the workspace folder          |
| `{directory_name}`                    | directory name                                     |
| `{full_directory_name}`               | full directory name                                |
| `{workspace}`                         | name of the workspace                              |
| `{workspace_folder}`                  | name of the workspace folder                       |
| `{workspace_and_folder}`              | name of the workspace and folder                   |
| `{lang}` \| `{Lang}` \| `{LANG}`      | format of the lang string (css, Css, CSS)          |
| `{a_lang}` \| `{a_Lang}`\| `{a_LANG}` | same as the above, but prefixes with "a" or "an"   |
| `{problems}`                          | problems text defined in settings                  |
| `{problems_pluralize}`                | the word `problem`, pluralized by count            |
| `{problems_count}`                    | number of problems                                 |
| `{problems_count_errors}`             | number of problems that are errors                 |
| `{problems_count_warnings}`           | number of problems that are warnings               |
| `{problems_count_infos}`              | number of problems that are infos                  |
| `{problems_count_hints}`              | number of problems that are hints                  |
| `{line_count}`                        | number of lines                                    |
| `{current_line}`                      | current line                                       |
| `{current_column}`                    | current column                                     |
| `{git_owner}`                         | current git repository owner                       |
| `{git_repo}`                          | repository name for current repository             |
| `{git_branch}`                        | current git branch                                 |
| `{git_protocol}`                      | git protocol (https, http, ssh)                    |
| `{git_resource}`                      | git resource link (etc: github.com) (exclude port) |
| `{git_host}`                          | git host link (etc: github.com) (include port)     |
| `{git_port}`                          | pot for the git link                               |
| `{git_href}`                          | href to the git repository                         |
| `{git_url}`                           | url link to the git repository                     |
| `{empty}`                             | an empty space                                     |

## 👨‍💻 Contributing

To contribute to this repository, feel free to create a new fork of the repository and submit a pull request.

1. Fork / Clone the `main` branch.
2. Create a new branch in your fork.
3. Make your changes.
4. Commit your changes and push them.
5. Submit a Pull Request [here](https://github.com/LeonardSSH/vscord/pulls)!

## 👨‍💻 Adding a new language

We have a guide for adding a new language [here](ADDING_LANGUAGE.md)!

## 🎉 Thanks

- [discordjs](https://github.com/discordjs/) - Creator of Discord RPC Client
- [iCrawl](https://github.com/iCrawl) - Creator of [discord-vscode](https://github.com/iCrawl/discord-vscode)
- [Satoqz](https://github.com/Satoqz) - Creator of [vscode-discord](https://github.com/Satoqz/vscode-discord/)

_Much of the code in this repository is based on [iCrawl/discord-vscode](https://github.com/iCrawl/discord-vscode) & [Satoqz/vscode-discord](https://github.com/Satoqz/vscode-discord). This extension would not exist without them._

## 📋 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

[vsmp-link]: https://marketplace.visualstudio.com/items?itemName=LeonardSSH.vscord
[ovsx-link]: https://open-vsx.org/extension/LeonardSSH/vscord
[shield-vsmp-version]: https://img.shields.io/visual-studio-marketplace/v/LeonardSSH.vscord?label=Visual%20Studio%20Marketplace
[shield-vsmp-downloads]: https://img.shields.io/visual-studio-marketplace/d/LeonardSSH.vscord
[shield-vsmp-installs]: https://img.shields.io/visual-studio-marketplace/i/LeonardSSH.vscord
[shield-vsmp-rating]: https://img.shields.io/visual-studio-marketplace/r/LeonardSSH.vscord
[shield-ovsx-version]: https://img.shields.io/open-vsx/v/LeonardSSH/vscord?label=OpenVSX%20Marketplace
[shield-ovsx-downloads]: https://img.shields.io/open-vsx/dt/LeonardSSH/vscord
[shield-ovsx-rating]: https://img.shields.io/open-vsx/rating/LeonardSSH/vscord
[github-workflows-ci]: https://github.com/leonardssh/vscord/actions/workflows/CI.yml
[shield-workflows-ci]: https://github.com/leonardssh/vscord/actions/workflows/CI.yml/badge.svg
[github-workflows-cd]: https://github.com/leonardssh/vscord/actions/workflows/CD.yml
[shield-workflows-cd]: https://github.com/leonardssh/vscord/actions/workflows/CD.yml/badge.svg
[gitter-vscord-support]: https://gitter.im/LeonardSSH/vscord-support?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge
[shield-gitter-support]: https://img.shields.io/badge/gitter-support%20chat-green?color=40aa8b
