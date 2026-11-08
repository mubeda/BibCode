# README screenshots

The images in this folder are the demo screenshots from [bibcode.dev](https://bibcode.dev). They show a
fictional "Acme Billing" workspace, never a real project. The root [README](../../../README.md) uses each
one as a light and dark pair, so a file `<name>.webp` always has a `<name>-dark.webp`.

## Sources

Each file is converted from `https://www.bibcode.dev/screenshots/<name>.png` (light) or
`https://www.bibcode.dev/screenshots/<name>-dark.png` (dark), 1672x941 PNG.

| Name               | Shows                                |
| ------------------ | ------------------------------------ |
| `fleet-workspace`  | Agents side by side in one workspace |
| `source-control`   | Source Control panel and diff        |
| `files-and-editor` | File tree and editor                 |
| `terminals`        | Terminal panes                       |
| `git-manager`      | Git Manager history                  |
| `pull-requests`    | Pull request review                  |
| `pipelines`        | CI pipeline job and log              |
| `remote-servers`   | Settings, Remote Servers             |
| `device-previews`  | Device preview beside the agent chat |

## Conversion and budget

Convert at full width with `cwebp -q 80 <name>.png -o <name>.webp`. Keep each file at 150 KB or less and the
folder at 1.5 MB or less; check with `du -k docs/assets/readme/*`.

## Refreshing

The files are copies, not hotlinks, so they do not change when the site does. When the site publishes new
screenshots, download the same names, convert them as above, check that they still show only demo data, and
update the alt text in the root README to match what each image shows. The `remote-servers` image shows the
BiBCode version the site ran when it was captured and will look dated until it is refreshed.
