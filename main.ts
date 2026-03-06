import {
	App,
	Editor,
	MarkdownPostProcessorContext,
	MarkdownView,
	Menu,
	Modal,
	Plugin,
	PluginSettingTab,
	Setting,
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
import { RangeSetBuilder } from "@codemirror/state";

// Syntax: {visible text::annotation}
const ANNOTATION_REGEX = /\{([^}]*?)::([^}]+)\}/g;

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

function processAnnotations(
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext
) {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];

	let node;
	while ((node = walker.nextNode())) {
		textNodes.push(node as Text);
	}

	for (const textNode of textNodes) {
		const text = textNode.textContent;
		if (!text) continue;

		ANNOTATION_REGEX.lastIndex = 0;
		const matches = [...text.matchAll(ANNOTATION_REGEX)];
		if (matches.length === 0) continue;

		const fragment = document.createDocumentFragment();
		let lastIndex = 0;

		for (const match of matches) {
			const matchStart = match.index!;
			const visibleText = match[1];
			const annotation = match[2];

			if (matchStart > lastIndex) {
				fragment.appendChild(
					document.createTextNode(text.slice(lastIndex, matchStart))
				);
			}

			const span = document.createElement("span");
			span.className = "inline-annotation";
			span.textContent = visibleText;
			span.setAttribute("data-annotation", annotation);
			fragment.appendChild(span);

			lastIndex = matchStart + match[0].length;
		}

		if (lastIndex < text.length) {
			fragment.appendChild(
				document.createTextNode(text.slice(lastIndex))
			);
		}

		textNode.replaceWith(fragment);
	}
}

// ── Popup ────────────────────────────────────────────────────────────

let activePopup: HTMLElement | null = null;
let activeHoverTarget: HTMLElement | null = null;
let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

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

	const popup = document.createElement("div");
	popup.className = "annotation-popup";

	const textarea = document.createElement("textarea");
	textarea.className = "annotation-popup-textarea";
	textarea.value = annotation;
	textarea.readOnly = true;
	textarea.rows = Math.min(annotation.split("\n").length, 10);
	popup.appendChild(textarea);

	if (anchor) {
		const resolved = resolveAnnotation(anchor);
		if (resolved) {
			const { found, editorView } = resolved;
			const btnRow = document.createElement("div");
			btnRow.className = "annotation-popup-buttons";

			const editBtn = document.createElement("button");
			editBtn.className = "annotation-popup-btn";
			editBtn.textContent = "Edit";
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
			btnRow.appendChild(editBtn);

			const deleteBtn = document.createElement("button");
			deleteBtn.className = "annotation-popup-btn annotation-popup-btn-danger";
			deleteBtn.textContent = "Remove";
			deleteBtn.addEventListener("click", () => {
				removePopup();
				editorView.dispatch({
					changes: { from: found.from, to: found.to, insert: found.visibleText },
				});
			});
			btnRow.appendChild(deleteBtn);

			popup.appendChild(btnRow);
		}
	}

	popup.style.visibility = "hidden";
	document.body.appendChild(popup);

	requestAnimationFrame(() => {
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

		popup.style.top = `${top}px`;
		popup.style.left = `${left}px`;
		popup.style.visibility = "";
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
		setTimeout(() => {
			document.addEventListener("click", close, true);
		}, 10);
	}

	if (pluginSettings.triggerMode === "hover") {
		popup.addEventListener("mouseenter", () => {
			if (hoverTimeout) {
				clearTimeout(hoverTimeout);
				hoverTimeout = null;
			}
		});
		popup.addEventListener("mouseleave", () => {
			hoverTimeout = setTimeout(removePopup, 150);
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
		const span = document.createElement("span");
		span.className = "inline-annotation";
		span.textContent = this.visibleText;
		span.setAttribute("data-annotation", this.annotation);
		return span;
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
		const doc = view.state.doc;

		for (const { from, to } of view.visibleRanges) {
			const text = doc.sliceString(from, to);
			ANNOTATION_REGEX.lastIndex = 0;
			let match;

			while ((match = ANNOTATION_REGEX.exec(text)) !== null) {
				const start = from + match.index;
				const end = start + match[0].length;

				const cursorInside = view.state.selection.ranges.some(
					(r) => r.from >= start && r.to <= end
				);

				if (!cursorInside) {
					builder.add(
						start,
						end,
						Decoration.replace({
							widget: new AnnotationWidget(match[1], match[2]),
						})
					);
				}
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
			const value = textarea.value;
			this.close();
			setTimeout(() => this.onSubmit(value), 50);
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

		setTimeout(() => {
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

function findAnnotationAt(lineText: string, lineFrom: number, pos: number): AnnotationMatch | null {
	ANNOTATION_REGEX.lastIndex = 0;
	let match;
	while ((match = ANNOTATION_REGEX.exec(lineText)) !== null) {
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

			const target = (e.target as HTMLElement)?.closest(
				".inline-annotation"
			) as HTMLElement | null;
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

			const target = (e.target as HTMLElement)?.closest(
				".inline-annotation"
			) as HTMLElement | null;
			if (!target || target === activeHoverTarget) return;

			const annotation = target.getAttribute("data-annotation");
			if (!annotation) return;

			if (hoverTimeout) {
				clearTimeout(hoverTimeout);
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

			const target = (e.target as HTMLElement)?.closest(
				".inline-annotation"
			) as HTMLElement | null;
			if (!target) return;

			hoverTimeout = setTimeout(removePopup, 150);
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
			const target = (e.target as HTMLElement)?.closest(
				".inline-annotation"
			) as HTMLElement | null;
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
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const selection = editor.getSelection();
				if (!selection) return;

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
				(menu: Menu, editor: Editor, view: MarkdownView) => {
					const selection = editor.getSelection();
					if (selection) {
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
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		pluginSettings = this.settings;
		pluginApp = this.app;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		pluginSettings = this.settings;
	}
}
