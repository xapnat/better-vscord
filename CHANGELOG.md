# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 6.1.0

- New setting: `vscord.app.customName` for a free text activity name

## 6.0.0

- Fork as Better VSCord
- Set the presence through Discord headless sessions (OAuth2 + PKCE with your own application) instead of local IPC, Discord does not need to be running
- New commands: Authorize with Discord, Remove Discord authorization
- New setting: `vscord.app.redirectPort`

## [5.3.10] - 2026-5-28

### Changed

- Switch from esbuild to rspack
