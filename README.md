# Inline Annotations for Obsidian

Add short notes to any text without creating a full page. Select a word or sentence, attach an annotation, and reveal it with a click or hover.

Perfect for TTRPG notes, study material, manuscripts, or anywhere you want hidden context on specific phrases.

https://github.com/user-attachments/assets/c38f869e-3c93-4b8f-a1c9-a2f25313c1a6

## How it works

Write annotations inline using the `{text::note}` syntax:

```markdown
The party finds a {locked chest::DC 15 — on failure, the mechanism jams}.
```

In reading view and live preview, only **locked chest** is visible. Click (or hover) to see the note in a popup above the text.

## Usage

### Create an annotation
1. Select text in the editor
2. Run **Annotate selection** from the command palette (`Ctrl/Cmd + P`), or right-click and choose **Annotate selection**

### View an annotation
- **Click mode** (default) — click the annotated text to show the popup, click elsewhere to dismiss
- **Hover mode** — hover over the text, popup disappears when you move away

### Edit or remove
Right-click any annotation in the editor to get **Edit annotation** or **Remove annotation** options.

## Settings

| Setting | Options | Description |
|---------|---------|-------------|
| Trigger mode | Click / Hover | How annotation popups are revealed |

## Installation

### From Obsidian Community Plugins
1. Open **Settings → Community plugins → Browse**
2. Search for **Inline Annotations**
3. Click **Install**, then **Enable**

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Create a folder `inline-annotations` in your vault's `.obsidian/plugins/` directory
3. Place the three files inside it
4. Enable the plugin in **Settings → Community plugins**

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```
