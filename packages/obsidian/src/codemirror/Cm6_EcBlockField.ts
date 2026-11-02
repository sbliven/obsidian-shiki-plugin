import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorSelection, Prec, StateEffect, StateField } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType } from '@codemirror/view';
import { editorLivePreviewField } from 'obsidian';
import { attachClickToEdit } from 'packages/obsidian/src/codemirror/Cm6_ClickToEdit';
import type ShikiPlugin from 'packages/obsidian/src/main';

/**
 * Renders unfocused fenced code blocks in Live Preview with Expressive Code.
 *
 * Why a StateField and not Obsidian's `registerMarkdownCodeBlockProcessor`:
 * with the latter, Obsidian owns the Live Preview widget. Its click handling, the "edit block" button
 * and the rule for when the widget turns back into source are all internal and can't be configured.
 * By owning the widget we decide:
 *   - when it is shown (no selection touches the block),
 *   - what a click does (cursor at the clicked character, see `Cm6_ClickToEdit`),
 *   - that a drag only selects text and leaves the widget alone.
 *
 * Block-level replace decorations have to come from a StateField (ViewPlugins can't provide them).
 */

/** Dispatch this to drop the render cache and redraw all widgets (e.g. after a theme change). */
export const refreshEcBlocksEffect = StateEffect.define<null>();

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/;

export interface FencedBlock {
	/** Start of the opening fence line. */
	from: number;
	/** End of the closing fence line. */
	to: number;
	language: string;
	meta: string;
	source: string;
}

/**
 * Finds closed, top-level fenced code blocks using Obsidian's markdown syntax tree.
 */
export function findFencedBlocks(state: EditorState): FencedBlock[] {
	const blocks: FencedBlock[] = [];
	const doc = state.doc;
	let open: { from: number; indent: number; language: string; meta: string } | null = null;

	syntaxTree(state).iterate({
		enter: node => {
			const name = node.type.name;
			if (!name.includes('HyperMD-codeblock-begin') && !name.includes('HyperMD-codeblock-end')) {
				return;
			}
			const line = doc.lineAt(node.from);

			if (name.includes('HyperMD-codeblock-begin')) {
				const m = FENCE_OPEN.exec(line.text);
				open = m ? { from: line.from, indent: m[1].length, language: m[3].toLowerCase(), meta: m[4].trim() } : null;
				return false;
			}

			if (open) {
				const first = doc.lineAt(open.from).number + 1;
				const lines: string[] = [];
				for (let n = first; n < line.number; n++) {
					// strip the fence's indentation from content lines, as CommonMark does
					lines.push(doc.line(n).text.replace(new RegExp(`^ {0,${open.indent}}`), ''));
				}
				blocks.push({ from: open.from, to: line.to, language: open.language, meta: open.meta, source: lines.join('\n') });
				open = null;
			}
			return false;
		},
	});

	return blocks;
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some(r => r.from <= to && r.to >= from);
}

class RenderCache {
	private cache = new Map<string, HTMLElement>();
	generation = 0;

	key(block: FencedBlock): string {
		return `${this.generation}\u0000${block.language}\u0000${block.meta}\u0000${block.source}`;
	}

	get(key: string): HTMLElement | undefined {
		const el = this.cache.get(key);
		if (el) {
			// refresh LRU position
			this.cache.delete(key);
			this.cache.set(key, el);
		}
		return el;
	}

	set(key: string, el: HTMLElement): void {
		this.cache.set(key, el);
		if (this.cache.size > 300) {
			this.cache.delete(this.cache.keys().next().value!);
		}
	}

	clear(): void {
		this.cache.clear();
		this.generation++;
	}
}

class EcBlockWidget extends WidgetType {
	constructor(
		private readonly plugin: ShikiPlugin,
		private readonly cache: RenderCache,
		private readonly block: FencedBlock,
		private readonly key: string,
	) {
		super();
	}

	eq(other: EcBlockWidget): boolean {
		return other.key === this.key;
	}

	get estimatedHeight(): number {
		// EC line height (~1.65em at the editor font size) plus frame padding.
		return this.block.source.split('\n').length * 22 + 40;
	}

	toDOM(view: EditorView): HTMLElement {
		// Mirror the Reading view DOM (`.markdown-rendered .block-language-<lang> > .expressive-code`) so that
		// theme and snippet CSS written for rendered code blocks applies here too, instead of us restyling anything.
		const wrapper = createDiv({ cls: ['shiki-lp-block', 'markdown-rendered'] });

		const cached = this.cache.get(this.key);
		if (cached) {
			wrapper.append(cached.cloneNode(true));
		} else {
			// Plain placeholder with the right number of lines, to keep layout jumps small while EC renders.
			const placeholder = wrapper.createEl('pre', { cls: 'shiki-lp-placeholder', text: this.block.source });
			void (async (): Promise<void> => {
				const container = createDiv({ cls: `block-language-${this.block.language}` });
				try {
					await this.plugin.highlighter.renderWithEc(this.block.source, this.block.language, this.block.meta, container);
				} catch (e) {
					console.warn('Shiki: failed to render code block in Live Preview', e);
					return;
				}
				this.cache.set(this.key, container);
				placeholder.replaceWith(container.cloneNode(true));
				view.requestMeasure();
			})();
		}

		attachClickToEdit({
			containerEl: wrapper,
			getSource: () => this.block.source,
			isEnabled: () => this.plugin.settings.clickToEdit,
			getView: () => view,
			listen: (el, type, cb) => el.addEventListener(type, cb),
		});

		return wrapper;
	}

	ignoreEvent(): boolean {
		// We handle mouse events ourselves (click-to-edit). Letting CodeMirror handle mousedown would make it
		// place the cursor at the widget boundary, which reveals the source before a drag selection can start.
		return true;
	}
}

function createEcBlockField(plugin: ShikiPlugin): StateField<DecorationSet> {
	const cache = new RenderCache();

	const build = (state: EditorState): DecorationSet => {
		if (!plugin.settings.livePreviewEcRendering || !state.field(editorLivePreviewField, false)) {
			return Decoration.none;
		}
		const languages = new Set(plugin.highlighter.obsidianSafeLanguageNames());
		const decorations: Range<Decoration>[] = [];

		for (const block of findFencedBlocks(state)) {
			if (!languages.has(block.language) || selectionTouches(state, block.from, block.to)) {
				continue;
			}
			const widget = new EcBlockWidget(plugin, cache, block, cache.key(block));
			decorations.push(Decoration.replace({ widget, block: true }).range(block.from, block.to));
		}
		return Decoration.set(decorations, true);
	};

	const needsRebuild = (tr: Transaction): boolean =>
		tr.docChanged ||
		tr.selection !== undefined ||
		syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
		tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false);

	const field = StateField.define<DecorationSet>({
		create: state => build(state),
		update: (value, tr) => {
			if (tr.effects.some(e => e.is(refreshEcBlocksEffect))) {
				cache.clear();
				return build(tr.state);
			}
			return needsRebuild(tr) ? build(tr.state) : value;
		},
		provide: f => EditorView.decorations.from(f),
	});

	return field;
}

/**
 * CodeMirror treats block widgets as atomic, so ArrowUp/ArrowDown would jump over a rendered block.
 * Instead, step onto its fence line (opening fence when moving down, closing fence when moving up),
 * which reveals the source just like moving line by line through a plain code block.
 */
function arrowIntoBlock(field: StateField<DecorationSet>, forward: boolean) {
	return (view: EditorView): boolean => {
		const sel = view.state.selection.main;
		if (!sel.empty) {
			return false;
		}
		const doc = view.state.doc;
		const line = doc.lineAt(sel.head);
		const next = view.moveVertically(sel, forward);
		if (doc.lineAt(next.head).number === line.number) {
			return false; // moving within a wrapped line
		}
		const [scanFrom, scanTo] = forward ? [line.to, next.head] : [next.head, line.from];
		let hit: { from: number; to: number } | null = null;
		view.state.field(field).between(scanFrom, scanTo, (from, to) => {
			if (forward ? from > line.to && (!hit || from < hit.from) : to < line.from && (!hit || to > hit.to)) {
				hit = { from, to };
			}
		});
		if (!hit) {
			return false;
		}
		const { from, to } = hit as { from: number; to: number };
		view.dispatch({
			selection: EditorSelection.cursor(forward ? from : doc.lineAt(to).from),
			scrollIntoView: true,
			userEvent: 'select',
		});
		return true;
	};
}

/**
 * The Live Preview Expressive Code extension: the decoration field plus a tiny view plugin that
 * lets the Obsidian plugin find open editors to refresh after a theme / settings change.
 */
export function createEcBlockExtension(plugin: ShikiPlugin): Extension {
	const tracker = ViewPlugin.define(view => {
		plugin.liveEditors.add(view);
		return { destroy: (): void => void plugin.liveEditors.delete(view) };
	});
	const field = createEcBlockField(plugin);
	return [
		field,
		tracker,
		Prec.highest(
			keymap.of([
				{ key: 'ArrowDown', run: arrowIntoBlock(field, true) },
				{ key: 'ArrowUp', run: arrowIntoBlock(field, false) },
			]),
		),
	];
}
