import {
	App,
	Editor,
	Menu,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
} from "obsidian";
import {
	Decoration,
	DecorationSet,
	EditorView,
	PluginValue,
	ViewPlugin,
	ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// Syntax: {visible text::annotation}
//
// Neither group may contain a newline. Without that restriction a stray "{"
// far above a "::" swallows everything in between -- which is how a Java or
// C++ code block ends up rendered as one giant annotation, and how a
// line-spanning replace decoration corrupts the CodeMirror document.
const ANNOTATION_PATTERN = "\\{([^}\\n]*?)::([^}\\n]+)\\}";

// A fresh regex per scan: a shared /g regex carries lastIndex between callers.
function annotationRegex(): RegExp {
	return new RegExp(ANNOTATION_PATTERN, "g");
}

// Contexts where "{a::b}" is code or markup, not an annotation.
const EXCLUDED_SELECTOR = "code, pre, .math, mjx-container";
const EXCLUDED_NODE_NAMES = ["code", "math", "frontmatter"];

// Walks up the syntax tree at pos looking for a code/math/frontmatter node.
function isExcludedContext(state: EditorState, pos: number): boolean {
	let node = syntaxTree(state).resolveInner(pos, 1);
	for (;;) {
		const name = node.name.toLowerCase();
		if (EXCLUDED_NODE_NAMES.some((n) => name.includes(n))) return true;
		const parent = node.parent;
		if (!parent) return false;
		node = parent;
	}
}

// Annotations live on one line, so a selection spanning lines can't become one.
function flattenAnnotation(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

type TriggerMode = "click" | "hover";

interface InlineAnnotationSettings {
	triggerMode: TriggerMode;
}

const DEFAULT_SETTINGS: InlineAnnotationSettings = {
	triggerMode: "click",
};

// Global references so module-level event handlers can access plugin state
let pluginSettings: InlineAnnotationSettings = DEFAULT_SETTINGS;
let pluginApp: App;

// ── Reading View Post-Processor ──────────────────────────────────────

function processAnnotations(el: HTMLElement) {
	const walker = el.doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];

	let node;
	while ((node = walker.nextNode())) {
		textNodes.push(node as Text);
	}

	for (const textNode of textNodes) {
		const text = textNode.textContent;
		if (!text) continue;

		// "std::vector" inside a code block is not an annotation.
		if (textNode.parentElement?.closest(EXCLUDED_SELECTOR)) continue;

		const regex = annotationRegex();
		const fragment = createFragment();
		let lastIndex = 0;
		let match: RegExpExecArray | null;

		while ((match = regex.exec(text)) !== null) {
			const matchStart = match.index;

			if (matchStart > lastIndex) {
				fragment.appendText(text.slice(lastIndex, matchStart));
			}

			fragment.createSpan({
				cls: "inline-annotation",
				text: match[1],
				attr: { "data-annotation": match[2] },
			});

			lastIndex = matchStart + match[0].length;
		}

		// No annotation on this text node: leave it untouched.
		if (lastIndex === 0) continue;

		if (lastIndex < text.length) {
			fragment.appendText(text.slice(lastIndex));
		}

		textNode.replaceWith(fragment);
	}
}

// ── Popup ────────────────────────────────────────────────────────────

let activePopup: HTMLElement | null = null;
let activeHoverTarget: HTMLElement | null = null;
let hoverTimeout: number | null = null;

function removePopup() {
	if (activePopup) {
		activePopup.remove();
		activePopup = null;
	}
	activeHoverTarget = null;
}

interface ResolvedAnnotation {
	found: AnnotationMatch;
	editorView: EditorView;
}

function resolveAnnotation(anchor: HTMLElement): ResolvedAnnotation | null {
	const cmEditor = anchor.closest(".cm-editor");
	if (!cmEditor) return null;

	const editorView = EditorView.findFromDOM(cmEditor as HTMLElement);
	if (!editorView) return null;

	const pos = editorView.posAtDOM(anchor);
	const lineObj = editorView.state.doc.lineAt(pos);
	const found = findAnnotationAt(lineObj.text, lineObj.from, pos);
	if (!found) return null;

	return { found, editorView };
}

function showAnnotationPopup(annotation: string, x: number, y: number, anchor?: HTMLElement) {
	removePopup();

	const popup = createDiv({ cls: "annotation-popup" });

	const textarea = popup.createEl("textarea", {
		cls: "annotation-popup-textarea",
	});
	textarea.value = annotation;
	textarea.readOnly = true;
	textarea.rows = Math.min(annotation.split("\n").length, 10);

	if (anchor) {
		const resolved = resolveAnnotation(anchor);
		if (resolved) {
			const { found, editorView } = resolved;
			const btnRow = popup.createDiv({ cls: "annotation-popup-buttons" });

			const editBtn = btnRow.createEl("button", {
				cls: "annotation-popup-btn",
				text: "Edit",
			});
			editBtn.addEventListener("click", () => {
				removePopup();
				new AnnotationModal(
					pluginApp,
					(newAnnotation) => {
						if (newAnnotation) {
							editorView.dispatch({
								changes: {
									from: found.from,
									to: found.to,
									insert: `{${found.visibleText}::${newAnnotation}}`,
								},
							});
						}
					},
					found.annotation,
					"Edit annotation"
				).open();
			});

			const deleteBtn = btnRow.createEl("button", {
				cls: "annotation-popup-btn annotation-popup-btn-danger",
				text: "Remove",
			});
			deleteBtn.addEventListener("click", () => {
				removePopup();
				editorView.dispatch({
					changes: { from: found.from, to: found.to, insert: found.visibleText },
				});
			});
		}
	}

	popup.addClass("is-hidden");
	document.body.appendChild(popup);

	window.requestAnimationFrame(() => {
		const popupWidth = popup.offsetWidth;
		const popupHeight = popup.offsetHeight;
		const pad = 8;

		// Find the line-level rect closest to the mouse/hover point.
		// getClientRects() returns one rect per line for inline elements,
		// so this handles multi-line annotations correctly.
		let lineRect: DOMRect | null = null;
		if (anchor) {
			const rects = anchor.getClientRects();
			let minDist = Infinity;
			for (let i = 0; i < rects.length; i++) {
				const r = rects[i];
				const dist = Math.abs((r.top + r.bottom) / 2 - y);
				if (dist < minDist) {
					minDist = dist;
					lineRect = r;
				}
			}
		}

		let top: number;
		let left: number;

		if (lineRect) {
			top = lineRect.top - popupHeight - 2;
			left = lineRect.left + lineRect.width / 2;
		} else {
			top = y - popupHeight - 2;
			left = x;
		}

		// The popup uses translateX(-50%) to center, so its real
		// edges are left ± popupWidth/2. Clamp to viewport.
		const halfW = popupWidth / 2;
		left = Math.max(halfW + pad, Math.min(left, window.innerWidth - halfW - pad));

		// If clipped above, flip below the anchor instead
		if (top < pad) {
			top = lineRect ? lineRect.bottom + 2 : y + 2;
		}

		popup.setCssProps({ "--popup-top": `${top}px`, "--popup-left": `${left}px` });
		popup.removeClass("is-hidden");
	});

	activePopup = popup;
	activeHoverTarget = anchor ?? null;

	if (pluginSettings.triggerMode === "click") {
		const close = (e: Event) => {
			if (!popup.contains(e.target as Node)) {
				removePopup();
				document.removeEventListener("click", close, true);
			}
		};
		window.setTimeout(() => {
			document.addEventListener("click", close, true);
		}, 10);
	}

	if (pluginSettings.triggerMode === "hover") {
		popup.addEventListener("mouseenter", () => {
			if (hoverTimeout) {
				window.clearTimeout(hoverTimeout);
				hoverTimeout = null;
			}
		});
		popup.addEventListener("mouseleave", () => {
			hoverTimeout = window.setTimeout(removePopup, 150);
		});
	}
}

// ── Live Preview (CM6) ──────────────────────────────────────────────

class AnnotationWidget extends WidgetType {
	constructor(
		readonly visibleText: string,
		readonly annotation: string
	) {
		super();
	}

	toDOM(): HTMLElement {
		return createSpan({
			cls: "inline-annotation",
			text: this.visibleText,
			attr: { "data-annotation": this.annotation },
		});
	}

	eq(other: AnnotationWidget) {
		return (
			this.visibleText === other.visibleText &&
			this.annotation === other.annotation
		);
	}

	ignoreEvent() {
		return true;
	}
}

class AnnotationViewPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged || update.selectionSet) {
			this.decorations = this.buildDecorations(update.view);
		}
	}

	buildDecorations(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();
		const { doc } = view.state;
		// Ranges must reach the builder in ascending order. A visible range can
		// start mid-line, so a line is scanned from its true start and may
		// overlap what the previous range already covered.
		let lastEnd = -1;

		for (const { from, to } of view.visibleRanges) {
			for (let pos = from; pos <= to; ) {
				const line = doc.lineAt(pos);
				const regex = annotationRegex();
				let match;

				while ((match = regex.exec(line.text)) !== null) {
					const start = line.from + match.index;
					const end = start + match[0].length;

					if (start < lastEnd) continue;
					if (isExcludedContext(view.state, start)) continue;

					const cursorInside = view.state.selection.ranges.some(
						(r) => r.from >= start && r.to <= end
					);
					if (cursorInside) continue;

					builder.add(
						start,
						end,
						Decoration.replace({
							widget: new AnnotationWidget(match[1], match[2]),
						})
					);
					lastEnd = end;
				}

				pos = line.to + 1;
			}
		}

		return builder.finish();
	}

	destroy() {}
}

const annotationViewPlugin = ViewPlugin.fromClass(AnnotationViewPlugin, {
	decorations: (v) => v.decorations,
});

// ── Prompt Modal ─────────────────────────────────────────────────────

class AnnotationModal extends Modal {
	private onSubmit: (result: string) => void;
	private initialValue: string;
	private title: string;

	constructor(
		app: App,
		onSubmit: (result: string) => void,
		initialValue = "",
		title = "Add annotation"
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.initialValue = initialValue;
		this.title = title;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.title });

		const textarea = contentEl.createEl("textarea", {
			cls: "annotation-modal-textarea",
			placeholder: "e.g. DC15 - you struggle",
		});
		textarea.value = this.initialValue;
		textarea.rows = 5;

		const submit = () => {
			// An annotation must stay on one line, so newlines become spaces.
			const value = flattenAnnotation(textarea.value);
			this.close();
			window.setTimeout(() => this.onSubmit(value), 50);
		};

		textarea.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				e.stopPropagation();
				submit();
			}
		});

		const buttonRow = contentEl.createDiv({ cls: "annotation-modal-buttons" });
		buttonRow.createEl("button", { text: "Save", cls: "mod-cta" })
			.addEventListener("click", submit);
		buttonRow.createEl("small", {
			text: "or press Ctrl+Enter",
			cls: "annotation-modal-hint",
		});

		window.setTimeout(() => {
			textarea.focus();
			textarea.select();
		}, 50);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

interface AnnotationMatch {
	visibleText: string;
	annotation: string;
	from: number;
	to: number;
}

// An annotation wraps its visible text on a single line. Annotating a
// selection that spans lines would produce a "{...::...}" straddling a line
// break -- unparseable, and in Live Preview a replace decoration across a
// line break corrupts the document.
function canAnnotateSelection(selection: string, notify = true): boolean {
	if (!selection.includes("\n")) return true;
	if (notify) {
		new Notice("Annotations cannot span multiple lines.");
	}
	return false;
}

function findAnnotationAt(lineText: string, lineFrom: number, pos: number): AnnotationMatch | null {
	const regex = annotationRegex();
	let match;
	while ((match = regex.exec(lineText)) !== null) {
		const from = lineFrom + match.index;
		const to = from + match[0].length;
		if (pos >= from && pos <= to) {
			return { visibleText: match[1], annotation: match[2], from, to };
		}
	}
	return null;
}

// ── Settings Tab ─────────────────────────────────────────────────────

class InlineAnnotationSettingTab extends PluginSettingTab {
	plugin: InlineAnnotationsPlugin;

	constructor(app: App, plugin: InlineAnnotationsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Obsidian 1.13+ renders these itself and indexes them for settings
	// search; display() below is only reached on older versions.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Trigger mode",
				desc: "How to reveal annotation popups",
				control: {
					type: "dropdown",
					key: "triggerMode",
					defaultValue: DEFAULT_SETTINGS.triggerMode,
					options: { click: "Click", hover: "Hover" },
				},
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Trigger mode")
			.setDesc("How to reveal annotation popups")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("click", "Click")
					.addOption("hover", "Hover")
					.setValue(this.plugin.settings.triggerMode)
					.onChange(async (value) => {
						this.plugin.settings.triggerMode = value as TriggerMode;
						await this.plugin.saveSettings();
					})
			);
	}
}

function getAnnotationTarget(e: Event): HTMLElement | null {
	const el = e.target;
	if (!(el instanceof HTMLElement)) return null;
	return el.closest<HTMLElement>(".inline-annotation");
}

// ── Main Plugin ──────────────────────────────────────────────────────

export default class InlineAnnotationsPlugin extends Plugin {
	settings: InlineAnnotationSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.registerMarkdownPostProcessor(processAnnotations);
		this.registerEditorExtension(annotationViewPlugin);
		this.addSettingTab(new InlineAnnotationSettingTab(this.app, this));

		// ── Click handler (capture phase) ────────────────────────
		const onClick = (e: MouseEvent) => {
			if (pluginSettings.triggerMode !== "click") return;

			const target = getAnnotationTarget(e);
			if (!target) return;

			const annotation = target.getAttribute("data-annotation");
			if (!annotation) return;

			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
			showAnnotationPopup(annotation, e.clientX, e.clientY, target);
		};
		document.addEventListener("click", onClick, true);
		this.register(() =>
			document.removeEventListener("click", onClick, true)
		);

		// ── Hover handlers (capture phase) ───────────────────────
		const onMouseOver = (e: MouseEvent) => {
			if (pluginSettings.triggerMode !== "hover") return;

			const target = getAnnotationTarget(e);
			if (!target || target === activeHoverTarget) return;

			const annotation = target.getAttribute("data-annotation");
			if (!annotation) return;

			if (hoverTimeout) {
				window.clearTimeout(hoverTimeout);
				hoverTimeout = null;
			}

			const rect = target.getBoundingClientRect();
			showAnnotationPopup(
				annotation,
				rect.left + rect.width / 2,
				rect.bottom,
				target
			);
		};

		const onMouseOut = (e: MouseEvent) => {
			if (pluginSettings.triggerMode !== "hover") return;

			const target = getAnnotationTarget(e);
			if (!target) return;

			hoverTimeout = window.setTimeout(removePopup, 150);
		};

		document.addEventListener("mouseover", onMouseOver, true);
		document.addEventListener("mouseout", onMouseOut, true);
		this.register(() => {
			document.removeEventListener("mouseover", onMouseOver, true);
			document.removeEventListener("mouseout", onMouseOut, true);
		});

		// Clean up popup when switching notes
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", removePopup)
		);
		this.register(removePopup);

		// ── Right-click on annotation widget (capture phase) ─────
		const onContextMenu = (e: MouseEvent) => {
			const target = getAnnotationTarget(e);
			if (!target) return;

			const cmEditor = target.closest(".cm-editor");
			if (!cmEditor) return;

			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();

			const editorView = EditorView.findFromDOM(cmEditor as HTMLElement);
			if (!editorView) return;

			const pos = editorView.posAtDOM(target);
			const lineObj = editorView.state.doc.lineAt(pos);
			const found = findAnnotationAt(lineObj.text, lineObj.from, pos);
			if (!found) return;

			const menu = new Menu();
			menu.addItem((item) => {
				item.setTitle("Edit annotation")
					.setIcon("pencil")
					.onClick(() => {
						new AnnotationModal(
							this.app,
							(newAnnotation) => {
								if (newAnnotation) {
									editorView.dispatch({
										changes: {
											from: found.from,
											to: found.to,
											insert: `{${found.visibleText}::${newAnnotation}}`,
										},
									});
								}
							},
							found.annotation,
							"Edit annotation"
						).open();
					});
			});
			menu.addItem((item) => {
				item.setTitle("Remove annotation")
					.setIcon("x-circle")
					.onClick(() => {
						editorView.dispatch({
							changes: {
								from: found.from,
								to: found.to,
								insert: found.visibleText,
							},
						});
					});
			});
			menu.showAtMouseEvent(e);
		};
		document.addEventListener("contextmenu", onContextMenu, true);
		this.register(() =>
			document.removeEventListener("contextmenu", onContextMenu, true)
		);

		// Command: annotate selected text
		this.addCommand({
			id: "annotate-selection",
			name: "Annotate selection",
			editorCallback: (editor: Editor) => {
				const selection = editor.getSelection();
				if (!selection) return;
				if (!canAnnotateSelection(selection)) return;

				new AnnotationModal(this.app, (annotation) => {
					if (annotation) {
						editor.replaceSelection(
							`{${selection}::${annotation}}`
						);
					}
				}).open();
			},
		});

		// Command: remove annotation (cursor inside one)
		this.addCommand({
			id: "remove-annotation",
			name: "Remove annotation from selection",
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				const found = findAnnotationAt(line, 0, cursor.ch);
				if (!found) return;

				editor.replaceRange(
					found.visibleText,
					{ line: cursor.line, ch: found.from },
					{ line: cursor.line, ch: found.to }
				);
			},
		});

		// Right-click context menu in editor
		this.registerEvent(
			this.app.workspace.on(
				"editor-menu",
				(menu: Menu, editor: Editor) => {
					const selection = editor.getSelection();
					if (selection && canAnnotateSelection(selection, false)) {
						menu.addItem((item) => {
							item.setTitle("Annotate selection")
								.setIcon("message-square")
								.onClick(() => {
									new AnnotationModal(
										this.app,
										(annotation) => {
											if (annotation) {
												editor.replaceSelection(
													`{${selection}::${annotation}}`
												);
											}
										}
									).open();
								});
						});
					}

					const cursor = editor.getCursor();
					const line = editor.getLine(cursor.line);
					const found = findAnnotationAt(line, 0, cursor.ch);
					if (!found) return;

					menu.addItem((item) => {
						item.setTitle("Edit annotation")
							.setIcon("pencil")
							.onClick(() => {
								new AnnotationModal(
									this.app,
									(newAnnotation) => {
										if (newAnnotation) {
											editor.replaceRange(
												`{${found.visibleText}::${newAnnotation}}`,
												{ line: cursor.line, ch: found.from },
												{ line: cursor.line, ch: found.to }
											);
										}
									},
									found.annotation,
									"Edit annotation"
								).open();
							});
					});

					menu.addItem((item) => {
						item.setTitle("Remove annotation")
							.setIcon("x-circle")
							.onClick(() => {
								editor.replaceRange(
									found.visibleText,
									{ line: cursor.line, ch: found.from },
									{ line: cursor.line, ch: found.to }
								);
							});
					});
				}
			)
		);
	}

	async loadSettings() {
		const saved = (await this.loadData()) as
			| Partial<InlineAnnotationSettings>
			| null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		pluginSettings = this.settings;
		pluginApp = this.app;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		pluginSettings = this.settings;
	}
}
