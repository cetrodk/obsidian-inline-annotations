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
	TextComponent,
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
const ANNOTATION_REGEX = /\{([^}]*?)\:\:([^}]+)\}/g;

type TriggerMode = "click" | "hover";

interface InlineAnnotationSettings {
	triggerMode: TriggerMode;
}

const DEFAULT_SETTINGS: InlineAnnotationSettings = {
	triggerMode: "click",
};

// Global reference so event handlers can read current settings
let pluginSettings: InlineAnnotationSettings = DEFAULT_SETTINGS;

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

function showAnnotationPopup(annotation: string, x: number, y: number, anchor?: HTMLElement) {
	removePopup();

	const popup = document.createElement("div");
	popup.className = "annotation-popup";
	popup.textContent = annotation;

	popup.style.visibility = "hidden";
	document.body.appendChild(popup);

	requestAnimationFrame(() => {
		const popupHeight = popup.offsetHeight;

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

		if (lineRect) {
			popup.style.top = `${lineRect.top - popupHeight - 2}px`;
			popup.style.left = `${lineRect.left + lineRect.width / 2}px`;
		} else {
			popup.style.top = `${y - popupHeight - 2}px`;
			popup.style.left = `${x}px`;
		}
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
	result: string = "";
	onSubmit: (result: string) => void;
	initialValue: string;
	title: string;

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

		const input = new TextComponent(contentEl);
		input.setPlaceholder("e.g. DC15 - you struggle");
		input.setValue(this.initialValue);
		input.inputEl.style.width = "100%";
		input.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				e.stopPropagation();
				const value = input.getValue();
				this.close();
				setTimeout(() => this.onSubmit(value), 50);
			}
		});

		setTimeout(() => {
			input.inputEl.focus();
			input.inputEl.select();
		}, 50);
	}

	onClose() {
		this.contentEl.empty();
	}
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

		// ── Right-click on annotation widget (capture phase) ─────
		const onContextMenu = (e: MouseEvent) => {
			const target = (e.target as HTMLElement)?.closest(
				".inline-annotation"
			) as HTMLElement | null;
			if (!target) return;

			// Only handle widgets inside an editor (cm-editor)
			const cmEditor = target.closest(".cm-editor");
			if (!cmEditor) return;

			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();

			// Find the EditorView and document position
			const editorView = EditorView.findFromDOM(cmEditor as HTMLElement);
			if (!editorView) return;

			const pos = editorView.posAtDOM(target);
			const doc = editorView.state.doc;
			const lineObj = doc.lineAt(pos);
			const lineText = lineObj.text;

			ANNOTATION_REGEX.lastIndex = 0;
			let match;
			while ((match = ANNOTATION_REGEX.exec(lineText)) !== null) {
				const matchFrom = lineObj.from + match.index;
				const matchTo = matchFrom + match[0].length;
				if (pos >= matchFrom && pos <= matchTo) {
					const visibleText = match[1];
					const currentAnnotation = match[2];

					const menu = new Menu();
					menu.addItem((item) => {
						item.setTitle("Edit annotation")
							.setIcon("pencil")
							.onClick(() => {
								new AnnotationModal(
									this.app,
									(newAnnotation) => {
										if (newAnnotation) {
											const change = {
												from: matchFrom,
												to: matchTo,
												insert: `{${visibleText}::${newAnnotation}}`,
											};
											editorView.dispatch({
												changes: change,
											});
										}
									},
									currentAnnotation,
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
										from: matchFrom,
										to: matchTo,
										insert: visibleText,
									},
								});
							});
					});
					menu.showAtMouseEvent(e);
					break;
				}
			}
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

				ANNOTATION_REGEX.lastIndex = 0;
				let match;
				while ((match = ANNOTATION_REGEX.exec(line)) !== null) {
					const start = match.index;
					const end = start + match[0].length;
					if (cursor.ch >= start && cursor.ch <= end) {
						editor.replaceRange(
							match[1],
							{ line: cursor.line, ch: start },
							{ line: cursor.line, ch: end }
						);
						return;
					}
				}
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
					ANNOTATION_REGEX.lastIndex = 0;
					let match;
					while ((match = ANNOTATION_REGEX.exec(line)) !== null) {
						const start = match.index;
						const end = start + match[0].length;
						if (cursor.ch >= start && cursor.ch <= end) {
							const visibleText = match[1];
							const currentAnnotation = match[2];
							const matchStart = start;
							const matchEnd = end;

							menu.addItem((item) => {
								item.setTitle("Edit annotation")
									.setIcon("pencil")
									.onClick(() => {
										new AnnotationModal(
											this.app,
											(newAnnotation) => {
												if (newAnnotation) {
													editor.replaceRange(
														`{${visibleText}::${newAnnotation}}`,
														{
															line: cursor.line,
															ch: matchStart,
														},
														{
															line: cursor.line,
															ch: matchEnd,
														}
													);
												}
											},
											currentAnnotation,
											"Edit annotation"
										).open();
									});
							});

							menu.addItem((item) => {
								item.setTitle("Remove annotation")
									.setIcon("x-circle")
									.onClick(() => {
										editor.replaceRange(
											visibleText,
											{
												line: cursor.line,
												ch: matchStart,
											},
											{
												line: cursor.line,
												ch: matchEnd,
											}
										);
									});
							});
							break;
						}
					}
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
		pluginSettings = this.settings;
	}
}
