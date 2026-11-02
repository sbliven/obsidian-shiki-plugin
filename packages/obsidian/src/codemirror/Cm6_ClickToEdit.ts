import type { Text } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * Click-to-edit for code blocks rendered by Expressive Code inside Live Preview.
 *
 * In Live Preview, Obsidian replaces every fenced code block that has a registered code block
 * processor with a block widget. Obsidian (not this plugin) owns that widget: it swallows clicks
 * and only drops the widget when the editor selection moves into the block's source range
 * (arrow keys, or the "edit block" button, which selects the whole block).
 *
 * We therefore don't need to "switch the block into edit mode" ourselves. It is enough to move
 * the CodeMirror selection to the source position that corresponds to the clicked character.
 * Obsidian's own Live Preview logic then replaces the widget with the editable source.
 */

/** Pixels the pointer may move between mousedown and mouseup and still count as a click. */
const DRAG_THRESHOLD_PX = 4;

/** Elements inside the EC block that have their own click behaviour. */
const INTERACTIVE_SELECTOR = 'a, button, summary, input, textarea, select, .edit-block-button, .copy';

export interface ClickTarget {
	/** 0-based line index within the code block content, or -1 for the opening fence line (e.g. a click on the frame title). */
	line: number;
	/** Character offset within the rendered line text. */
	ch: number;
}

interface CaretDocument {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	// Non-standard WebKit API, needed for older iOS / Android WebViews without `caretPositionFromPoint`.
	legacyCaretRangeFromPoint?: (x: number, y: number) => Range | null;
}

function caretFromPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
	const caretDoc = doc as unknown as CaretDocument;
	const pos = caretDoc.caretPositionFromPoint?.call(doc, x, y);
	if (pos) {
		return { node: pos.offsetNode, offset: pos.offset };
	}
	const legacy = (doc as unknown as Record<string, CaretDocument['legacyCaretRangeFromPoint']>)['caretRangeFromPoint'];
	const range = legacy?.call(doc, x, y);
	if (range) {
		return { node: range.startContainer, offset: range.startOffset };
	}
	return null;
}

/**
 * Number of characters of `container`'s text content that precede the given DOM point.
 */
export function textOffsetWithin(container: Node, node: Node, offset: number): number | null {
	if (!container.contains(node)) {
		return null;
	}
	const range = container.ownerDocument!.createRange();
	range.selectNodeContents(container);
	range.setEnd(node, offset);
	return range.toString().length;
}

/**
 * Number of leading blank lines. Expressive Code drops these before rendering,
 * so rendered line `i` corresponds to source line `i + leadingBlankLines(source)`.
 */
export function leadingBlankLines(source: string): number {
	const lines = source.split(/\r?\n/);
	let n = 0;
	while (n < lines.length && lines[n].trim() === '') {
		n++;
	}
	return n === lines.length ? 0 : n;
}

/**
 * Determines which rendered line and character the user clicked on.
 * Returns `null` if the click didn't land on code text or the frame header.
 */
export function clickTargetFromEvent(ecRoot: HTMLElement, event: MouseEvent): ClickTarget | null {
	const target = event.target as HTMLElement | null;
	if (!target) {
		return null;
	}

	// Clicking the frame header (title / terminal bar) puts the cursor on the opening fence, where the meta string lives.
	if (target.closest('figcaption')) {
		return { line: -1, ch: Number.MAX_SAFE_INTEGER };
	}

	const lines = Array.from(ecRoot.querySelectorAll<HTMLElement>('.ec-line'));
	let lineEl = target.closest<HTMLElement>('.ec-line');

	// Click in the padding of the <pre>, i.e. not on a line: pick the vertically closest line.
	if (!lineEl) {
		lineEl = closestLineByY(lines, event.clientY);
		if (!lineEl) {
			return null;
		}
	}

	const lineIndex = lines.indexOf(lineEl);
	if (lineIndex < 0) {
		return null;
	}

	const codeEl = lineEl.querySelector<HTMLElement>('.code') ?? lineEl;
	let ch = Number.MAX_SAFE_INTEGER; // default: end of line (e.g. click in the gutter or right of the text)
	const caret = caretFromPoint(ecRoot.ownerDocument, event.clientX, event.clientY);
	if (caret) {
		const offset = textOffsetWithin(codeEl, caret.node, caret.offset);
		if (offset !== null) {
			ch = offset;
		} else if (lineEl.querySelector('.gutter')?.contains(caret.node)) {
			ch = 0;
		}
	}

	return { line: lineIndex, ch };
}

function closestLineByY(lines: HTMLElement[], y: number): HTMLElement | null {
	let best: HTMLElement | null = null;
	let bestDist = Infinity;
	for (const line of lines) {
		const rect = line.getBoundingClientRect();
		if (rect.height === 0) {
			continue; // collapsed section
		}
		const dist = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
		if (dist < bestDist) {
			best = line;
			bestDist = dist;
		}
	}
	return best;
}

/**
 * Converts a click target to a document offset.
 *
 * @param doc the CodeMirror document
 * @param fenceLine 0-based line number of the opening fence
 * @param source the code block content as passed to the code block processor
 */
export function docPosForTarget(doc: Text, fenceLine: number, source: string, target: ClickTarget): number | null {
	if (fenceLine < 0 || fenceLine + 1 > doc.lines) {
		return null;
	}

	if (target.line < 0) {
		return doc.line(fenceLine + 1).to;
	}

	const sourceLines = source.split(/\r?\n/);
	const sourceLineIndex = target.line + leadingBlankLines(source);
	const docLineNumber = fenceLine + 2 + sourceLineIndex; // CM lines are 1-based, +1 to skip the fence
	if (docLineNumber > doc.lines) {
		return null;
	}

	const docLine = doc.line(docLineNumber);
	const sourceLine = sourceLines[sourceLineIndex] ?? '';
	// Code blocks inside callouts / lists have a prefix (e.g. "> ") that isn't part of `source`.
	const prefix = docLine.text.endsWith(sourceLine) ? docLine.text.length - sourceLine.length : 0;
	const ch = Math.min(target.ch, sourceLine.trimEnd().length, docLine.length - prefix);
	return docLine.from + prefix + Math.max(0, ch);
}

const FENCE_REGEX = /^[\s>]*(?:(?:[-*+]|\d+[.)])\s+)?(?:`{3,}|~{3,})/;

/**
 * Finds the 0-based line of the opening fence of a code block with content `source`,
 * scanning forward from `startLine` (the first line of the widget that contains the rendered block).
 *
 * For a top-level code block widget `startLine` is the fence itself. For a code block nested in a
 * callout (or any other rendered embed), it is the first line of that embed, and the code block is further down.
 * We match on content rather than trusting `ctx.getSectionInfo`, whose line numbers are relative to
 * the embed's own markdown in that case.
 */
export function findFenceLine(doc: Text, startLine: number, source: string, maxScan: number = 5000): number | null {
	const sourceLines = source.split(/\r?\n/).map(l => l.trimEnd());
	if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') {
		sourceLines.pop();
	}
	const checkLines = sourceLines.slice(0, 50);

	const last = Math.min(doc.lines - 1, startLine + maxScan);
	for (let l = Math.max(0, startLine); l <= last; l++) {
		if (!FENCE_REGEX.test(doc.line(l + 1).text)) {
			continue;
		}
		if (l + 1 + checkLines.length > doc.lines) {
			return null;
		}
		const matches = checkLines.every((src, i) =>
			doc
				.line(l + 2 + i)
				.text.trimEnd()
				.endsWith(src),
		);
		if (matches) {
			return l;
		}
	}
	return null;
}

function findFenceLineForElement(view: EditorView, el: HTMLElement, source: string): number | null {
	try {
		const pos = view.posAtDOM(el);
		return findFenceLine(view.state.doc, view.state.doc.lineAt(pos).number - 1, source);
	} catch {
		return null;
	}
}

type Listen = (el: HTMLElement, type: 'mousedown' | 'click', cb: (ev: MouseEvent) => void) => void;

export interface ClickToEditOptions {
	containerEl: HTMLElement;
	getSource: () => string;
	isEnabled: () => boolean;
	/** Returns the editor that contains `containerEl`, or null if it's not in an editable Live Preview editor. */
	getView: () => EditorView | null;
	listen: Listen;
}

/**
 * Finds the Live Preview editor that contains `el`, if any.
 */
export function liveEditorViewFor(el: HTMLElement): EditorView | null {
	const cmEl = el.closest<HTMLElement>('.cm-editor');
	if (!cmEl || !el.closest('.is-live-preview')) {
		return null; // reading view, embeds in reading mode, hover popovers, ...
	}
	return EditorView.findFromDOM(cmEl);
}

/**
 * Wires up click-to-edit on a rendered code block.
 *
 * A plain click (pointer moved less than a few px, no modifier, nothing selected) puts the cursor at the
 * clicked character. A drag is left to the browser, so text can be selected and copied from the rendered block.
 */
export function attachClickToEdit(opts: ClickToEditOptions): void {
	const { containerEl } = opts;
	let down: { x: number; y: number } | null = null;

	opts.listen(containerEl, 'mousedown', ev => {
		down = ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null;
	});

	opts.listen(containerEl, 'click', ev => {
		const start = down;
		down = null;

		if (!opts.isEnabled() || !start || ev.button !== 0 || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) {
			return;
		}
		// A drag (text selection): leave the rendered block alone so the user can copy text.
		if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > DRAG_THRESHOLD_PX) {
			return;
		}
		const sel = containerEl.ownerDocument.getSelection();
		if (sel && !sel.isCollapsed && sel.anchorNode && containerEl.contains(sel.anchorNode)) {
			return;
		}
		const target = ev.target as HTMLElement | null;
		if (!target || target.closest(INTERACTIVE_SELECTOR)) {
			return;
		}

		const view = opts.getView();
		if (!view) {
			return;
		}

		const ecRoot = containerEl.querySelector<HTMLElement>('.expressive-code') ?? containerEl;
		const clickTarget = clickTargetFromEvent(ecRoot, ev);
		if (!clickTarget) {
			return;
		}

		const source = opts.getSource();
		const fenceLine = findFenceLineForElement(view, containerEl, source);
		if (fenceLine === null) {
			return;
		}
		const pos = docPosForTarget(view.state.doc, fenceLine, source, clickTarget);
		if (pos === null) {
			return;
		}

		ev.preventDefault();
		ev.stopPropagation();

		moveCursorKeepingLineUnderPointer(view, pos, ev.clientY);
	});
}

/**
 * Places the cursor at `pos` and focuses the editor. Rendered and source views of a code block
 * differ in height (frame, padding, title), so after Obsidian swaps the widget for the source we
 * scroll by the difference, keeping the clicked line under the mouse pointer instead of jumping.
 */
function moveCursorKeepingLineUnderPointer(view: EditorView, pos: number, pointerY: number): void {
	view.focus();
	view.dispatch({
		selection: EditorSelection.cursor(pos),
		scrollIntoView: false,
		userEvent: 'select.pointer',
	});

	view.requestMeasure({
		read: v => v.coordsAtPos(pos),
		write: (coords, v) => {
			if (!coords) {
				return;
			}
			const lineMiddle = (coords.top + coords.bottom) / 2;
			const delta = lineMiddle - pointerY;
			if (Math.abs(delta) > 1) {
				v.scrollDOM.scrollTop += delta;
			}
		},
	});
}
