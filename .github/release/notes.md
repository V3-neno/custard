## Download

| Computer                              | File                              |
| ------------------------------------- | --------------------------------- |
| Windows (64-bit)                      | `custard-<version>-setup.exe`     |
| Mac with Apple Silicon (M1 and later) | `custard-<version>-mac-arm64.dmg` |
| Mac with an Intel chip                | `custard-<version>-mac-x64.dmg`   |

The `.zip` files hold the same Mac app without the disk image. `SHA256SUMS.txt` lists each file's checksum.

## First launch

These builds are not signed with a paid certificate, so the system warns once per version.

- **Windows:** SmartScreen says "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** open the `.dmg` and drag Custard to Applications. The first open is blocked. Go to **System Settings > Privacy & Security**, scroll down, and click **Open Anyway** next to Custard. If macOS instead says the app "is damaged", run `xattr -cr /Applications/Custard.app` in Terminal and open it again.

## Starter vault and Obsidian

The starter vault is inside Custard: **Settings > Create starter vault** writes a "Custard Brain" folder wherever you choose. Obsidian is a separate, free download from [obsidian.md/download](https://obsidian.md/download); Custard can't include it. In Obsidian, choose **Open folder as vault** and pick "Custard Brain".
