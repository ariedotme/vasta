# Changelog

What changed in each release, for the people who use Vasta. New entries go under **Unreleased**;
`scripts/release.sh` names that section after the version, and the release workflow puts it on the
GitHub release page.

## Unreleased

### Added

- **The desktop app works without a server.** On first start, choose **Start on this computer**:
  the app runs Vasta itself, with nothing to install or set up, and your notes stay on that
  computer. The start page says what you give up (your phone, Telegram captures, backups are
  yours to make). The menu-bar item's **Open Notes Folder** shows where the notes are.
- **Move to a server**, from Settings › Server in the desktop app: paste a server's setup code or
  an invite link, choose a username and password, and your notes, their history and your files
  move into a new account there. Then the app switches to that server.
- Servers take notes moved from another Vasta (needed for the above): update your server before
  moving notes to it.

### Changed

- On the desktop app's own server, the account menu has no Log out or Change password, and
  Settings › Server accounts explains why there are no other accounts.

## 0.3.0 (2026-10-22)

### Added

- **Templates**: start a type's objects or each day's note from a template, with placeholders
  (`{{date:+7d}}`, `{{ask:With whom?}}`) and blocks shown only when a condition holds.
- **Snippets**: save a piece of text and insert it with `/`.
- Agents can list and use templates and snippets.

### Changed

- Typed lines (`/Task Ask Lena due:fri`) take English words only.

## 0.2.0 (2026-10-22)

The first public version.
